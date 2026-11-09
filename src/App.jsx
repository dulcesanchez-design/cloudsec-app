import { useMemo, useState } from 'react'
import course from './data/course.json'
import { Card, Lab, WordCard, exerciseComponents, shuffle } from './Exercises'
import { buildExam, buildReviewStep, buildSessionSteps, hasEnglishVoice } from './vocab'

const moduleFiles = import.meta.glob('./data/modules/*.json', {
  eager: true,
  import: 'default',
})

const STORAGE_KEY = 'cloudsec-progress-v2'
const XP_PER_EXERCISE = 10
const XP_LESSON_BONUS = 5
const MIN_APROBACION = 0.7 // fracción mínima de aciertos a la primera para aprobar un módulo
const REVIEW_INTERVALS = [1, 3, 7, 14] // días hasta el próximo repaso, por caja (Leitner)
const REVIEW_XP_PER_HIT = 5 // XP por acierto en una sesión de repaso
const REVIEW_SESSION_SIZE = 20 // máximo de ejercicios por sesión de repaso
const WORD_OFFSETS = [2, 4, 7, 14] // días desde la fecha de aprendizaje para repasar una palabra
const WORD_SESSION_SIZE = 20 // máximo de palabras por sesión de repaso de vocabulario
const EXAM_SIZE = 20 // palabras por examen de nivel (si el nivel tiene menos, se usan todas)
const EXAM_PASS = 0.8 // fracción mínima de aciertos para aprobar un examen de nivel

// Los módulos de vocabulario traen "sessions"; se exponen como "lessons" de tipo vocab
// para reutilizar la navegación, el desbloqueo en orden y el progreso por lección.
function normalizeModuleData(d) {
  if (!d?.sessions) return d
  return {
    ...d,
    lessons: d.sessions.map((s) => ({ title: s.title, kind: 'vocab', words: s.words, source: d.source })),
  }
}

const loadModule = (m) => ({ ...m, data: normalizeModuleData(moduleFiles[`./data/modules/${m.file}`]) })

// Un curso trae "modules" (plano) o "levels" (cada nivel con sus módulos). Con niveles,
// "modules" sigue existiendo como lista plana para el resto de la app.
// Para agregar el nivel C1: añadir otro objeto { id, title, modules } al final de "levels".
const courses = course.courses.map((c) => {
  if (c.levels) {
    const levels = c.levels.map((l) => ({ ...l, modules: l.modules.map(loadModule) }))
    return { ...c, levels, modules: levels.flatMap((l) => l.modules) }
  }
  return { ...c, modules: c.modules.map(loadModule) }
})
const allModules = courses.flatMap((c) => c.modules)
const courseOf = (mod) => courses.find((c) => c.modules.some((m) => m.id === mod.id))

const lessonKey = (modId, i) => `${modId}:${i}`
const pctText = (f) => `${Math.round(f * 100)}%`
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)

// ---------- Repaso espaciado ----------
// Id estable de un ejercicio: módulo + lección + posición del paso ("idModulo:leccion:paso").
const stepId = (modId, lessonIdx, stepIdx) => `${modId}:${lessonIdx}:${stepIdx}`

// Devuelve el ejercicio de un id, o null si ya no existe (o no es un ejercicio).
function resolveStep(id) {
  const [modId, li, si] = String(id).split(':')
  const mod = allModules.find((m) => m.id === modId)
  const step = mod?.data.lessons[Number(li)]?.steps?.[Number(si)]
  return step && exerciseComponents[step.type] ? { mod, step } : null
}

// ---------- Repaso de vocabulario (por palabra) ----------
// Id estable de una palabra: módulo + sesión + posición ("idModulo:sesion:palabra").
const wordId = (modId, sessionIdx, wordIdx) => `${modId}:${sessionIdx}:${wordIdx}`

function resolveWord(id) {
  const [modId, si, wi] = String(id).split(':')
  const mod = allModules.find((m) => m.id === modId)
  const word = mod?.data.sessions?.[Number(si)]?.words?.[Number(wi)]
  return word ? { mod, word } : null
}

// Limpia la cola de palabras: descarta entradas mal formadas o cuyo id ya no existe.
function normalizeWords(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const [id, e] of Object.entries(raw)) {
    if (!isObj(e) || !Number.isInteger(e.stage) || e.stage < 0 || e.stage >= WORD_OFFSETS.length) continue
    if (typeof e.due !== 'string' || typeof e.learned !== 'string' || !resolveWord(id)) continue
    out[id] = { stage: e.stage, learned: e.learned, due: e.due, last: typeof e.last === 'string' ? e.last : null }
  }
  return out
}

// Limpia la cola: descarta entradas mal formadas o cuyo id ya no existe.
function normalizeReview(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const [id, e] of Object.entries(raw)) {
    if (!isObj(e) || !Number.isInteger(e.box) || e.box < 0 || e.box >= REVIEW_INTERVALS.length) continue
    if (typeof e.due !== 'string' || !resolveStep(id)) continue
    out[id] = { box: e.box, due: e.due }
  }
  return out
}

function normalizeFails(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const [id, n] of Object.entries(raw)) {
    if (Number.isInteger(n) && n > 0 && resolveWord(id)) out[id] = n
  }
  return out
}

const isScore = (x) => typeof x === 'number' && x >= 0 && x <= 1

function normalizeExams(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const [id, e] of Object.entries(raw)) {
    if (!isObj(e)) continue
    out[id] = {
      passed: e.passed === true,
      date: typeof e.date === 'string' ? e.date : null,
      score: isScore(e.score) ? e.score : null,
      last: isScore(e.last) ? e.last : null,
    }
  }
  return out
}

// ---------- Progreso (una sola clave de localStorage) ----------
// {
//   done:   ["idModulo:indice", ...]            lecciones terminadas
//   xp, streak, lastDay                          XP, racha y último día de estudio (YYYY-MM-DD local)
//   scores: { "idModulo:indice": {c, t} }        aciertos a la primera / ejercicios, última vez por lección
//   mods:   { idModulo: {best, passed} }         mejor fracción de aciertos y si está aprobado
// }

//   review: { "idModulo:leccion:paso": {box, due} }   cola de repaso: caja Leitner (0-3) y fecha del próximo repaso
//   words:  { "idModulo:sesion:palabra": {stage, learned, due, last} }   cola de vocabulario: etapa (0-3), fecha de aprendizaje, próximo repaso y último tipo de ejercicio
//   wfails: { "idModulo:sesion:palabra": n }   fallos acumulados en el repaso de vocabulario (pesan en el examen)
//   exams:  { idNivel: {passed, date, score, last} }   examen de nivel: aprobado, fecha y puntaje del aprobado (0-1), último intento
const emptyProgress = () => ({
  done: [], xp: 0, streak: 0, lastDay: null, scores: {}, mods: {}, review: {}, words: {}, wfails: {}, exams: {},
})

// Progreso anterior a la aprobación por módulo: los módulos completos quedan aprobados
// (sin porcentaje); las lecciones sueltas de módulos incompletos se descartan porque
// no tienen puntuación y no se podría calcular el porcentaje del módulo.
function migrateLegacy(p) {
  let done = [...p.done]
  const mods = {}
  for (const m of allModules) {
    const all = m.data.lessons.every((_, i) => done.includes(lessonKey(m.id, i)))
    if (all) mods[m.id] = { best: null, passed: true }
    else done = done.filter((k) => !k.startsWith(`${m.id}:`))
  }
  return { ...p, done, mods }
}

function loadProgress() {
  try {
    let raw = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (Array.isArray(raw)) raw = { done: raw } // formato más antiguo
    if (isObj(raw)) {
      const p = {
        done: Array.isArray(raw.done) ? raw.done.filter((x) => typeof x === 'string') : [],
        xp: Number.isFinite(raw.xp) ? raw.xp : 0,
        streak: Number.isFinite(raw.streak) ? raw.streak : 0,
        lastDay: typeof raw.lastDay === 'string' ? raw.lastDay : null,
        scores: isObj(raw.scores) ? raw.scores : {},
        mods: isObj(raw.mods) ? raw.mods : {},
        review: normalizeReview(raw.review),
        words: normalizeWords(raw.words),
        wfails: normalizeFails(raw.wfails),
        exams: normalizeExams(raw.exams),
      }
      return isObj(raw.mods) ? p : migrateLegacy(p)
    }
  } catch {
    // lectura fallida: se empieza desde cero
  }
  return emptyProgress()
}

function saveProgress(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // sin almacenamiento: el progreso solo dura la sesión
  }
}

// ---------- Fechas locales (no UTC) ----------
const pad = (n) => String(n).padStart(2, '0')
const dayString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = () => dayString(new Date())
const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return dayString(d)
}

// Suma n días a una fecha local "YYYY-MM-DD".
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number)
  return dayString(new Date(y, m - 1, d + n))
}

// Racha que se muestra: si pasó más de un día sin estudiar, vale 0.
function shownStreak(p) {
  return p.lastDay === today() || p.lastDay === yesterday() ? p.streak : 0
}

// Registra una lección terminada hoy: la racha sube una sola vez por día.
function registerStudyDay(p) {
  const t = today()
  if (p.lastDay === t) return p
  return { ...p, streak: p.lastDay === yesterday() ? p.streak + 1 : 1, lastDay: t }
}

// ---------- Cola de repaso: reglas ----------
// Ejercicios pendientes hoy (fecha local): vencidos y que todavía existen,
// ordenados del más atrasado (fecha de repaso más antigua) al menos atrasado.
const pendingIds = (p) => {
  const t = today()
  return Object.entries(p.review)
    .filter(([id, e]) => e.due <= t && resolveStep(id))
    .sort(([ida, a], [idb, b]) => (a.due < b.due ? -1 : a.due > b.due ? 1 : ida < idb ? -1 : 1))
    .map(([id]) => id)
}

// Fallo a la primera en una lección: entra (o vuelve) a la caja 0 y sale mañana.
const queueForReview = (p, id) => ({
  ...p,
  review: { ...p.review, [id]: { box: 0, due: addDays(today(), 1) } },
})

// Resultado de un ejercicio en una sesión de repaso.
function applyReview(p, id, ok) {
  const e = p.review[id]
  if (!e) return p
  const review = { ...p.review }
  if (!ok) {
    review[id] = { box: 0, due: addDays(today(), 1) }
  } else if (e.box >= REVIEW_INTERVALS.length - 1) {
    delete review[id] // acertó en el último intervalo: sale de la cola
  } else {
    review[id] = { box: e.box + 1, due: addDays(today(), REVIEW_INTERVALS[e.box + 1]) }
  }
  return { ...p, review }
}

// ---------- Niveles y examen de nivel ----------
const levelHasContent = (l) => l.modules.length > 0

// Nivel desbloqueado: el primero siempre; los demás al aprobar el examen del anterior.
const levelUnlocked = (c, li, p) => li === 0 || Boolean(p.exams[c.levels[li - 1].id]?.passed)

// Módulo desbloqueado dentro de su nivel (en orden).
const levelModuleUnlocked = (l, j, p) => j === 0 || modulePassed(l.modules[j - 1], p)

// Sesiones terminadas / total de un nivel.
function levelProgress(l, p) {
  let done = 0
  let total = 0
  for (const m of l.modules) {
    m.data.lessons.forEach((_, i) => {
      total += 1
      if (p.done.includes(lessonKey(m.id, i))) done += 1
    })
  }
  return { done, total }
}

// Palabras del nivel con su peso para el sorteo del examen:
// nunca estudiadas (sesión sin terminar) pesan 3; las falladas en el repaso pesan 1 + 2 por fallo (máx. 3 fallos).
function examEntries(l, p) {
  const out = []
  for (const m of l.modules) {
    m.data.sessions.forEach((s, si) => {
      const studied = p.done.includes(lessonKey(m.id, si))
      s.words.forEach((word, wi) => {
        const id = wordId(m.id, si, wi)
        const fails = Math.min(p.wfails[id] || 0, 3)
        const weight = fails > 0 ? 1 + 2 * fails : studied ? 1 : 3
        out.push({ id, word, mod: m, weight })
      })
    })
  }
  return out
}

// ---------- Cola de vocabulario: reglas ----------
// Palabras que tocan hoy (fecha local), de la más atrasada a la menos atrasada.
const pendingWords = (p) => {
  const t = today()
  return Object.entries(p.words)
    .filter(([id, e]) => e.due <= t && resolveWord(id))
    .sort(([ida, a], [idb, b]) => (a.due < b.due ? -1 : a.due > b.due ? 1 : ida < idb ? -1 : 1))
    .map(([id]) => id)
}

// Al terminar una sesión de aprendizaje, todas sus palabras entran a la cola (o se reinician).
function enrollWords(p, mod, sessionIdx) {
  const t = today()
  const words = { ...p.words }
  mod.data.sessions[sessionIdx].words.forEach((_, wi) => {
    words[wordId(mod.id, sessionIdx, wi)] = { stage: 0, learned: t, due: addDays(t, WORD_OFFSETS[0]), last: null }
  })
  return { ...p, words }
}

// Resultado de una palabra en una sesión de repaso de vocabulario.
function applyWordReview(p, id, ok, usedType) {
  const e = p.words[id]
  if (!e) return p
  const t = today()
  const words = { ...p.words }
  let wfails = p.wfails
  if (!ok) {
    // Fallo: vuelve al primer intervalo (+2 días desde hoy) y el calendario se reancla a hoy.
    words[id] = { stage: 0, learned: t, due: addDays(t, WORD_OFFSETS[0]), last: usedType }
    wfails = { ...p.wfails, [id]: (p.wfails[id] || 0) + 1 } // pesa en el sorteo del examen
  } else if (e.stage >= WORD_OFFSETS.length - 1) {
    delete words[id] // acertó el de +14: sale de la cola
  } else {
    // Acierto: siguiente intervalo del calendario fijo (fecha de aprendizaje + offset);
    // si esa fecha ya pasó (repaso tardío), vuelve a tocar mañana.
    const stage = e.stage + 1
    const fixed = addDays(e.learned, WORD_OFFSETS[stage])
    words[id] = { ...e, stage, due: fixed > t ? fixed : addDays(t, 1), last: usedType }
  }
  return { ...p, words, wfails }
}

// ---------- Aprobación por módulo ----------
// Fracción de aciertos a la primera sobre todos los ejercicios del módulo,
// o null si falta la puntuación de alguna lección.
function modulePercent(m, scores) {
  let c = 0
  let t = 0
  for (let i = 0; i < m.data.lessons.length; i++) {
    const s = scores[lessonKey(m.id, i)]
    if (!s || !Number.isFinite(s.c) || !(s.t > 0)) return null
    c += s.c
    t += s.t
  }
  return t > 0 ? c / t : null
}

const moduleFinished = (m, done) =>
  m.data.lessons.every((_, i) => done.includes(lessonKey(m.id, i)))

const modulePassed = (m, p) => Boolean(p.mods[m.id]?.passed)

// El bloqueo en orden solo aplica dentro de cada curso; los cursos son independientes.
const moduleUnlocked = (c, idx, p) => idx === 0 || modulePassed(c.modules[idx - 1], p)

const approvedCount = (c, p) => c.modules.filter((m) => modulePassed(m, p)).length

function moduleStatus(m, p) {
  const info = p.mods[m.id]
  if (info?.passed && m.data.sessions) return { label: '✓ Completado', cls: 'finished' }
  if (info?.passed) return { label: `✓ Aprobado${info.best != null ? ` · mejor ${pctText(info.best)}` : ''}`, cls: 'finished' }
  if (info?.best != null) return { label: `Por repetir · mejor ${pctText(info.best)}`, cls: 'retry' }
  return null
}

function Stats({ progress }) {
  return (
    <div className="stats">
      <span title="Racha de días">🔥 {shownStreak(progress)}</span>
      <span title="Experiencia total">⭐ {progress.xp} XP</span>
    </div>
  )
}

function Sources({ source }) {
  if (!source) return null
  const list = Array.isArray(source) ? source : [source]
  return (
    <p className="source">
      Fuente:{' '}
      {list.map((url, i) => (
        <span key={url}>
          {i > 0 && ' · '}
          <a href={url} target="_blank" rel="noreferrer">
            {url.replace('https://', '')}
          </a>
        </span>
      ))}
    </p>
  )
}

function Home({ progress, onOpen, onReset, onReview, onWordReview }) {
  const pending = pendingIds(progress).length
  const pendingVocab = pendingWords(progress).length
  return (
    <main className="app">
      <header>
        <p className="module">Cloud Security</p>
        <h1>Cursos</h1>
        <Stats progress={progress} />
      </header>
      <button className="btn primary" disabled={pending === 0} onClick={onReview}>
        Repaso del día ({pending > REVIEW_SESSION_SIZE ? `${REVIEW_SESSION_SIZE} de ${pending}` : pending})
      </button>
      <button className="btn" disabled={pendingVocab === 0} onClick={onWordReview}>
        Repaso de vocabulario ({pendingVocab > WORD_SESSION_SIZE ? `${WORD_SESSION_SIZE} de ${pendingVocab}` : pendingVocab})
      </button>
      <div className="options">
        {courses.map((c) => {
          const approved = approvedCount(c, progress)
          return (
            <button key={c.id} className="btn module-btn course-btn" onClick={() => onOpen(c.id)}>
              {c.recommended && <span className="badge">Recomendado primero</span>}
              <span className="module-title">{c.title}</span>
              <span className="module-desc">{c.description}</span>
              <span className="module-status">
                {approved} de {c.modules.length} módulos {c.kind === 'vocab' ? 'completados' : 'aprobados'}
              </span>
            </button>
          )
        })}
      </div>
      <button className="reset" onClick={onReset}>
        Reiniciar progreso
      </button>
    </main>
  )
}

function CourseView({ course: c, progress, onOpen, onBack }) {
  const { done } = progress
  return (
    <main className="app">
      <header>
        <button className="back" onClick={onBack}>
          ← Cursos
        </button>
        <h1>{c.title}</h1>
        <p className="progress">
          {approvedCount(c, progress)} de {c.modules.length} módulos {c.kind === 'vocab' ? 'completados' : 'aprobados'}
        </p>
      </header>
      <div className="options">
        {c.modules.map((m, i) => {
          const unlocked = moduleUnlocked(c, i, progress)
          const status = moduleStatus(m, progress)
          const count = m.data.lessons.filter((_, j) => done.includes(lessonKey(m.id, j))).length
          return (
            <button
              key={m.id}
              className={`btn module-btn${unlocked ? '' : ' locked'}${status ? ` ${status.cls}` : ''}`}
              disabled={!unlocked}
              onClick={() => onOpen(m.id)}
            >
              <span className="module-title">
                {!unlocked && '🔒 '}
                {m.title}
              </span>
              <span className="module-desc">
                {unlocked
                  ? `${m.description} · ${count}/${m.data.lessons.length} lecciones`
                  : 'Aprueba el módulo anterior para desbloquear'}
              </span>
              {unlocked && status && <span className="module-status">{status.label}</span>}
            </button>
          )
        })}
      </div>
      <p className="hint center">
        {c.kind === 'vocab'
          ? 'Basta con terminar las sesiones de un módulo para completarlo.'
          : `Para aprobar un módulo necesitas ${pctText(MIN_APROBACION)} de aciertos a la primera.`}
      </p>
    </main>
  )
}

// Curso por niveles: cada nivel es una sección con su progreso, sus módulos y su examen.
function LevelsView({ course: c, progress, onOpen, onBack, onExam }) {
  const { done } = progress
  return (
    <main className="app">
      <header>
        <button className="back" onClick={onBack}>
          ← Cursos
        </button>
        <h1>{c.title}</h1>
        <p className="progress">
          {approvedCount(c, progress)} de {c.modules.length} módulos completados
        </p>
      </header>

      {c.levels.map((l, li) => {
        const content = levelHasContent(l)
        const unlocked = levelUnlocked(c, li, progress)
        const open = content && unlocked
        const { done: sd, total: st } = levelProgress(l, progress)
        const exam = progress.exams[l.id]
        return (
          <section key={l.id} className={`level${open ? '' : ' level-locked'}`}>
            <div className="level-head">
              <h2>
                {!open && '🔒 '}Nivel {l.title}
              </h2>
              <span className="level-count">
                {sd} de {st} sesiones
              </span>
            </div>

            {!content && <p className="level-note">Próximamente</p>}
            {content && !unlocked && (
              <p className="level-note">Aprueba el examen del nivel {c.levels[li - 1].title} para desbloquearlo.</p>
            )}

            {open && (
              <>
                <div className="options">
                  {l.modules.map((m, j) => {
                    const mUnlocked = levelModuleUnlocked(l, j, progress)
                    const status = moduleStatus(m, progress)
                    const count = m.data.lessons.filter((_, k) => done.includes(lessonKey(m.id, k))).length
                    return (
                      <button
                        key={m.id}
                        className={`btn module-btn${mUnlocked ? '' : ' locked'}${status ? ` ${status.cls}` : ''}`}
                        disabled={!mUnlocked}
                        onClick={() => onOpen(m.id)}
                      >
                        <span className="module-title">
                          {!mUnlocked && '🔒 '}
                          {m.title}
                        </span>
                        <span className="module-desc">
                          {mUnlocked
                            ? `${m.description} · ${count}/${m.data.lessons.length} sesiones`
                            : 'Completa el módulo anterior para desbloquear'}
                        </span>
                        {mUnlocked && status && <span className="module-status">{status.label}</span>}
                      </button>
                    )
                  })}
                </div>

                <button className="btn" onClick={() => onExam(l)}>
                  Examen de nivel {l.title}
                </button>
                <p className="hint">
                  {exam?.passed
                    ? `Examen aprobado: ${pctText(exam.score ?? 0)}${exam.date ? ` · ${exam.date}` : ''}. Puedes repetirlo.`
                    : exam?.last != null
                      ? `Último intento: ${pctText(exam.last)}. Necesitas ${pctText(EXAM_PASS)} para aprobar.`
                      : `${EXAM_SIZE} palabras al azar del nivel. Necesitas ${pctText(EXAM_PASS)} para aprobar.`}
                </p>
              </>
            )}
          </section>
        )
      })}
    </main>
  )
}

// Examen de nivel: ejercicios variados, sin XP, sin cola de repaso; se aprueba con EXAM_PASS.
function ExamPlayer({ level, nextLevel, items, onFinish, onRetry, onExit }) {
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok, pts }
  const [points, setPoints] = useState(0)
  const [finished, setFinished] = useState(false)

  const total = useMemo(() => items.reduce((n, it) => n + it.weight, 0), [items])
  const item = items[idx]

  const handleDone = (ok, detail) => {
    // Unir da puntaje parcial: cada palabra bien unida suma, cada toque equivocado resta.
    const pts = ok ? item.weight : Math.max(0, item.weight - (detail?.mistakes ?? item.weight))
    setAnswer({ ok, pts })
    setPoints((n) => n + pts)
  }

  const advance = () => {
    setAnswer(null)
    if (idx + 1 >= items.length) {
      setFinished(true)
      onFinish(points, total)
    } else {
      setIdx(idx + 1)
    }
  }

  if (finished) {
    const score = total > 0 ? points / total : 0
    const passed = score >= EXAM_PASS
    return (
      <main className="app">
        <section className="card result">
          <h2>Examen de nivel {level.title}</h2>
          <p className="score">{pctText(score)}</p>
          <p>
            {points} de {total} puntos · mínimo {pctText(EXAM_PASS)}
          </p>
          <div className={`feedback ${passed ? 'ok' : 'bad'}`}>
            <strong>{passed ? '¡Examen aprobado!' : 'Todavía no alcanzas el mínimo'}</strong>
            <p>
              {passed
                ? nextLevel
                  ? levelHasContent(nextLevel)
                    ? `Se desbloquea el nivel ${nextLevel.title}.`
                    : `El nivel ${nextLevel.title} se desbloquea, pero aún está «Próximamente».`
                  : 'Completaste todos los niveles disponibles.'
                : 'Sin penalización: puedes repetirlo con otras palabras al azar.'}
            </p>
          </div>
          <button className="btn primary" onClick={onRetry}>
            {passed ? 'Hacer otro examen' : 'Repetir examen'}
          </button>
          <button className="btn" onClick={onExit}>
            Volver al curso
          </button>
        </section>
      </main>
    )
  }

  const { step: s } = item
  const Exercise = exerciseComponents[s.type]

  return (
    <main className="app">
      <div className="topbar">
        <button className="close" onClick={onExit} aria-label="Salir">
          ✕
        </button>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${Math.round((idx / items.length) * 100)}%` }} />
        </div>
      </div>
      <p className="lesson-title">
        Examen de nivel {level.title} · {idx + 1} de {items.length}
      </p>

      <section className="card">
        <Exercise key={idx} step={s} onDone={handleDone} />
        {answer && (
          <>
            <div className={`feedback ${answer.ok ? 'ok' : 'bad'}`}>
              <strong>
                {answer.ok
                  ? '¡Correcto!'
                  : item.weight > 1
                    ? `Sumaste ${answer.pts} de ${item.weight} puntos`
                    : 'Incorrecto'}
              </strong>
              <p>{s.why}</p>
            </div>
            <button className="btn primary" onClick={advance}>
              Continuar
            </button>
          </>
        )}
      </section>
    </main>
  )
}

function LessonList({ mod, progress, onOpen, onBack, onRepeatModule }) {
  const { done } = progress
  const info = progress.mods[mod.id]
  const pct = modulePercent(mod, progress.scores)
  const finished = moduleFinished(mod, done)
  return (
    <main className="app">
      <header>
        <button className="back" onClick={onBack}>
          ← Módulos
        </button>
        <h1>{mod.title}</h1>
        {info?.best != null && (
          <p className="progress">
            {info.passed ? 'Aprobado' : 'Por repetir'} · mejor resultado {pctText(info.best)}
          </p>
        )}
      </header>
      <div className="options">
        {mod.data.lessons.map((l, i) => {
          const lessonDone = done.includes(lessonKey(mod.id, i))
          const unlocked = i === 0 || done.includes(lessonKey(mod.id, i - 1))
          return (
            <button
              key={i}
              className={`btn module-btn${unlocked ? '' : ' locked'}${lessonDone ? ' finished' : ''}`}
              disabled={!unlocked}
              onClick={() => onOpen(i)}
            >
              <span className="module-title">
                {!unlocked && '🔒 '}
                {lessonDone && '✓ '}
                {i + 1}. {l.title}
              </span>
            </button>
          )
        })}
      </div>
      {finished && !info?.passed && pct !== null && (
        <div className="feedback bad">
          <strong>Necesitas repasar este módulo</strong>
          <p>
            Obtuviste {pctText(pct)} de aciertos a la primera; el mínimo es {pctText(MIN_APROBACION)}.
          </p>
        </div>
      )}
      {finished && (
        <button className="btn" onClick={onRepeatModule}>
          Repetir módulo
        </button>
      )}
    </main>
  )
}

function Player({ lesson, progress, mod, isLast, hasNext, onExit, onFinish, onNext, onRepeat, onRepeatModule, onFail }) {
  const isVocab = lesson.kind === 'vocab'
  // En vocabulario los ejercicios se generan a partir de las palabras (una sola vez al abrir la sesión).
  const [steps] = useState(() => (isVocab ? buildSessionSteps(lesson, mod, hasEnglishVoice()) : lesson.steps))
  const [queue, setQueue] = useState(() => steps.map((s, i) => ({ s, i, retry: false })))
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok }
  const [correct, setCorrect] = useState(0) // aciertos a la primera
  const [finished, setFinished] = useState(false)

  const totalExercises = useMemo(
    () => steps.filter((s) => !['card', 'wordcard', 'lab'].includes(s.type)).length,
    [steps],
  )

  const earned = correct * XP_PER_EXERCISE + XP_LESSON_BONUS

  const item = queue[idx]

  const handleDone = (ok) => {
    setAnswer({ ok })
    if (!item.retry) {
      if (ok) setCorrect((c) => c + 1)
      else {
        setQueue((q) => [...q, { s: item.s, i: item.i, retry: true }])
        if (!isVocab) onFail(item.i) // fallo a la primera: entra a la cola de repaso (el vocabulario se repasa por palabra)
      }
    }
  }

  const advance = () => {
    setAnswer(null)
    if (idx + 1 >= queue.length) {
      setFinished(true)
      onFinish(earned, { c: correct, t: totalExercises })
    } else {
      setIdx(idx + 1)
    }
  }

  const pct = finished ? 100 : Math.round((idx / queue.length) * 100)

  if (finished) {
    // En vocabulario no hay porcentaje mínimo: basta con terminar las sesiones.
    const modPct = isLast && !isVocab ? modulePercent(mod, progress.scores) : null
    const passed = modPct !== null && modPct >= MIN_APROBACION
    return (
      <main className="app">
        <section className="card result">
          <Stats progress={progress} />
          <h2>¡Lección completada!</h2>
          <p className="score">
            {correct} / {totalExercises}
          </p>
          <p>aciertos a la primera</p>
          <p className="xp-earned">
            +{earned} XP{' '}
            <span className="muted">
              ({correct}×{XP_PER_EXERCISE} + {XP_LESSON_BONUS} de bonus)
            </span>
          </p>

          {isVocab && (
            <div className="feedback ok">
              <strong>{isLast ? '¡Módulo completado!' : 'Sesión completada'}</strong>
              <p>
                Tus {lesson.words.length} palabras entran al repaso de vocabulario: el primero toca en{' '}
                {WORD_OFFSETS[0]} días.
              </p>
            </div>
          )}

          {modPct !== null && (
            <div className={`feedback ${passed ? 'ok' : 'bad'}`}>
              <strong>{passed ? '¡Módulo aprobado!' : 'Necesitas repasar este módulo'}</strong>
              <p>
                Aciertos a la primera en todo el módulo: {pctText(modPct)} (mínimo {pctText(MIN_APROBACION)}).
                {passed && ' Se desbloquea el siguiente módulo.'}
              </p>
            </div>
          )}

          {hasNext && (
            <button className="btn primary" onClick={onNext}>
              Siguiente lección
            </button>
          )}
          {modPct !== null && !passed && (
            <button className="btn primary" onClick={onRepeatModule}>
              Repetir módulo
            </button>
          )}
          <button className="btn" onClick={onRepeat}>
            Repetir lección
          </button>
          <button className="btn" onClick={onExit}>
            Volver
          </button>
          <Sources source={lesson.source} />
        </section>
      </main>
    )
  }

  const { s } = item
  const Exercise = exerciseComponents[s.type]

  return (
    <main className="app">
      <div className="topbar">
        <button className="close" onClick={onExit} aria-label="Salir">
          ✕
        </button>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="lesson-title">
        {lesson.title}
        {item.retry && ' · repaso de un fallo'}
      </p>

      <section className="card">
        {s.type === 'card' ? (
          <Card step={s} />
        ) : s.type === 'wordcard' ? (
          <WordCard key={`${idx}`} step={s} />
        ) : s.type === 'lab' ? (
          <Lab key={`${idx}`} step={s} onComplete={advance} />
        ) : (
          <Exercise key={`${idx}`} step={s} onDone={handleDone} />
        )}

        {(s.type === 'card' || s.type === 'wordcard') && (
          <button className="btn primary" onClick={advance}>
            Continuar
          </button>
        )}

        {answer && (
          <>
            <div className={`feedback ${answer.ok ? 'ok' : 'bad'}`}>
              <strong>{answer.ok ? '¡Correcto!' : 'Casi. Lo repetiremos al final.'}</strong>
              <p>{s.why}</p>
            </div>
            <button className="btn primary" onClick={advance}>
              Continuar
            </button>
          </>
        )}
      </section>
    </main>
  )
}

// Sesión de repaso: sirve para ejercicios (kind "exercise") y para palabras de vocabulario (kind "word").
function ReviewPlayer({ items, progress, onAnswer, onFinish, onExit, kind = 'exercise' }) {
  const isWord = kind === 'word'
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok }
  const [hits, setHits] = useState(0)
  const [finished, setFinished] = useState(false)

  const item = items[idx]

  const handleDone = (ok) => {
    setAnswer({ ok })
    if (ok) setHits((h) => h + 1)
    onAnswer(item.id, ok, item.step.gen) // la caja y la fecha se guardan en cada respuesta
  }

  const advance = () => {
    setAnswer(null)
    if (idx + 1 >= items.length) {
      setFinished(true)
      onFinish(hits)
    } else {
      setIdx(idx + 1)
    }
  }

  if (finished) {
    return (
      <main className="app">
        <section className="card result">
          <Stats progress={progress} />
          <h2>¡Repaso completado!</h2>
          <p className="score">
            {hits} / {items.length}
          </p>
          <p>aciertos</p>
          <p className="xp-earned">
            +{hits * REVIEW_XP_PER_HIT} XP{' '}
            <span className="muted">
              ({hits}×{REVIEW_XP_PER_HIT})
            </span>
          </p>
          <p>
            {isWord
              ? `Avanzaron de intervalo: ${hits} (las que acertaron el de +14 días salen de la cola). Vuelven a +2 días: ${items.length - hits}.`
              : `Subieron de caja: ${hits}. Volverán a la caja inicial: ${items.length - hits}.`}
          </p>
          <button className="btn primary" onClick={onExit}>
            Volver al inicio
          </button>
        </section>
      </main>
    )
  }

  const { step: s } = item
  const Exercise = exerciseComponents[s.type]

  return (
    <main className="app">
      <div className="topbar">
        <button className="close" onClick={onExit} aria-label="Salir">
          ✕
        </button>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${Math.round((idx / items.length) * 100)}%` }} />
        </div>
      </div>
      <p className="lesson-title">
        {isWord ? 'Repaso de vocabulario' : 'Repaso del día'} · {item.modTitle}
      </p>

      <section className="card">
        <Exercise key={idx} step={s} onDone={handleDone} />
        {answer && (
          <>
            <div className={`feedback ${answer.ok ? 'ok' : 'bad'}`}>
              <strong>
                {answer.ok ? '¡Correcto!' : isWord ? 'Casi. Volverá a salir en 2 días.' : 'Casi. Volverá a salir mañana.'}
              </strong>
              <p>{s.why}</p>
            </div>
            <button className="btn primary" onClick={advance}>
              Continuar
            </button>
          </>
        )}
      </section>
    </main>
  )
}

function App() {
  const [progress, setProgress] = useState(loadProgress)
  const [view, setView] = useState({ name: 'home' }) // home | module | lesson

  const update = (fn) =>
    setProgress((p) => {
      const next = fn(p)
      saveProgress(next)
      return next
    })

  const finishLesson = (mod, i, xpEarned, score) =>
    update((p) => {
      const key = lessonKey(mod.id, i)
      let next = {
        ...p,
        done: p.done.includes(key) ? p.done : [...p.done, key],
        xp: p.xp + xpEarned,
        scores: { ...p.scores, [key]: score },
      }
      if (mod.data.sessions) {
        // Vocabulario: sus palabras entran a la cola y, sin porcentaje mínimo, terminar la última sesión completa el módulo.
        next = enrollWords(next, mod, i)
        if (i === mod.data.lessons.length - 1) {
          next = { ...next, mods: { ...next.mods, [mod.id]: { best: null, passed: true } } }
        }
        return registerStudyDay(next)
      }
      // Al terminar la última lección se evalúa el módulo
      if (i === mod.data.lessons.length - 1) {
        const pct = modulePercent(mod, next.scores)
        if (pct !== null) {
          const prev = next.mods[mod.id] || { best: null, passed: false }
          next = {
            ...next,
            mods: {
              ...next.mods,
              [mod.id]: {
                best: Math.max(prev.best ?? 0, pct),
                passed: prev.passed || pct >= MIN_APROBACION,
              },
            },
          }
        }
      }
      return registerStudyDay(next)
    })

  // Reinicia solo las lecciones de ese módulo; XP, racha, otros módulos y el mejor resultado se conservan.
  const repeatModule = (mod) => {
    update((p) => {
      const keys = mod.data.lessons.map((_, i) => lessonKey(mod.id, i))
      const scores = { ...p.scores }
      keys.forEach((k) => delete scores[k])
      return { ...p, done: p.done.filter((k) => !keys.includes(k)), scores }
    })
    setView({ name: 'module', modId: mod.id })
  }

  const failFirstTry = (id) => update((p) => queueForReview(p, id))
  const answerReview = (id, ok) => update((p) => applyReview(p, id, ok))
  // Una sesión de repaso completada cuenta para la racha y da XP por acierto.
  const finishReview = (hits) =>
    update((p) => registerStudyDay({ ...p, xp: p.xp + hits * REVIEW_XP_PER_HIT }))

  const startReview = () => {
    // Los más atrasados primero; el resto sigue pendiente para la siguiente sesión.
    const items = pendingIds(progress).slice(0, REVIEW_SESSION_SIZE).map((id) => {
      const { mod: m, step } = resolveStep(id)
      return { id, step, modTitle: m.title }
    })
    if (items.length === 0) return
    setView({ name: 'review', items: shuffle(items), nonce: Date.now() })
  }

  // Examen de nivel: no agrega palabras a la cola de repaso, no suma XP ni cuenta para la racha.
  const startExam = (c, level) => {
    const items = buildExam(examEntries(level, progress), hasEnglishVoice(), EXAM_SIZE)
    if (items.length === 0) return
    setView({ name: 'exam', courseId: c.id, levelId: level.id, items, nonce: Date.now() })
  }

  const finishExam = (levelId, points, total) =>
    update((p) => {
      const score = total > 0 ? points / total : 0
      const prev = p.exams[levelId] || { passed: false, date: null, score: null, last: null }
      const passedNow = score >= EXAM_PASS
      // Aprobar guarda fecha y puntaje; repetir un examen ya aprobado solo actualiza si mejora el puntaje.
      const record = passedNow && (!prev.passed || score > (prev.score ?? 0))
      return {
        ...p,
        exams: {
          ...p.exams,
          [levelId]: {
            passed: prev.passed || passedNow,
            date: record ? today() : prev.date,
            score: record ? score : prev.score,
            last: score,
          },
        },
      }
    })

  // Repaso de vocabulario: ejercicios variados generados por palabra, las más atrasadas primero.
  const answerWord = (id, ok, usedType) => update((p) => applyWordReview(p, id, ok, usedType))

  const startWordReview = () => {
    const voice = hasEnglishVoice()
    const items = pendingWords(progress)
      .slice(0, WORD_SESSION_SIZE)
      .map((id) => {
        const { mod: m, word } = resolveWord(id)
        const step = buildReviewStep(word, m, progress.words[id].last, voice)
        return { id, step, modTitle: m.title }
      })
    if (items.length === 0) return
    setView({ name: 'wordreview', items: shuffle(items), nonce: Date.now() })
  }

  const resetProgress = () => {
    if (!window.confirm('¿Reiniciar todo el progreso, el XP y la racha? No se puede deshacer.')) return
    const fresh = emptyProgress()
    saveProgress(fresh)
    setProgress(fresh)
  }

  if (view.name === 'home') {
    return (
      <Home
        progress={progress}
        onOpen={(courseId) => setView({ name: 'course', courseId })}
        onReset={resetProgress}
        onReview={startReview}
        onWordReview={startWordReview}
      />
    )
  }

  if (view.name === 'wordreview') {
    return (
      <ReviewPlayer
        key={view.nonce}
        kind="word"
        items={view.items}
        progress={progress}
        onAnswer={answerWord}
        onFinish={finishReview}
        onExit={() => setView({ name: 'home' })}
      />
    )
  }

  if (view.name === 'review') {
    return (
      <ReviewPlayer
        key={view.nonce}
        items={view.items}
        progress={progress}
        onAnswer={answerReview}
        onFinish={finishReview}
        onExit={() => setView({ name: 'home' })}
      />
    )
  }

  if (view.name === 'exam') {
    const c = courses.find((x) => x.id === view.courseId)
    const li = c.levels.findIndex((l) => l.id === view.levelId)
    const level = c.levels[li]
    return (
      <ExamPlayer
        key={view.nonce}
        level={level}
        nextLevel={c.levels[li + 1]}
        items={view.items}
        onFinish={(points, total) => finishExam(level.id, points, total)}
        onRetry={() => startExam(c, level)}
        onExit={() => setView({ name: 'course', courseId: c.id })}
      />
    )
  }

  if (view.name === 'course') {
    const c = courses.find((x) => x.id === view.courseId)
    if (c.levels) {
      return (
        <LevelsView
          course={c}
          progress={progress}
          onBack={() => setView({ name: 'home' })}
          onOpen={(modId) => setView({ name: 'module', modId })}
          onExam={(level) => startExam(c, level)}
        />
      )
    }
    return (
      <CourseView
        course={c}
        progress={progress}
        onBack={() => setView({ name: 'home' })}
        onOpen={(modId) => setView({ name: 'module', modId })}
      />
    )
  }

  const mod = allModules.find((m) => m.id === view.modId)

  if (view.name === 'module') {
    return (
      <LessonList
        mod={mod}
        progress={progress}
        onBack={() => setView({ name: 'course', courseId: courseOf(mod).id })}
        onOpen={(i) => setView({ name: 'lesson', modId: mod.id, i, nonce: 0 })}
        onRepeatModule={() => repeatModule(mod)}
      />
    )
  }

  const lesson = mod.data.lessons[view.i]
  const isLast = view.i === mod.data.lessons.length - 1

  return (
    <Player
      key={`${mod.id}-${view.i}-${view.nonce}`}
      lesson={lesson}
      mod={mod}
      progress={progress}
      isLast={isLast}
      hasNext={!isLast}
      onExit={() => setView({ name: 'module', modId: mod.id })}
      onFinish={(xp, score) => finishLesson(mod, view.i, xp, score)}
      onNext={() => setView({ name: 'lesson', modId: mod.id, i: view.i + 1, nonce: 0 })}
      onRepeat={() => setView({ ...view, nonce: view.nonce + 1 })}
      onFail={(si) => failFirstTry(stepId(mod.id, view.i, si))}
      onRepeatModule={() => repeatModule(mod)}
    />
  )
}

export default App
