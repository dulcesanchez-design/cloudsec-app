import { useMemo, useState } from 'react'
import course from './data/course.json'
import { Card, Lab, exerciseComponents, shuffle } from './Exercises'

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

const courses = course.courses.map((c) => ({
  ...c,
  modules: c.modules.map((m) => ({
    ...m,
    data: moduleFiles[`./data/modules/${m.file}`],
  })),
}))
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
  const step = mod?.data.lessons[Number(li)]?.steps[Number(si)]
  return step && exerciseComponents[step.type] ? { mod, step } : null
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

// ---------- Progreso (una sola clave de localStorage) ----------
// {
//   done:   ["idModulo:indice", ...]            lecciones terminadas
//   xp, streak, lastDay                          XP, racha y último día de estudio (YYYY-MM-DD local)
//   scores: { "idModulo:indice": {c, t} }        aciertos a la primera / ejercicios, última vez por lección
//   mods:   { idModulo: {best, passed} }         mejor fracción de aciertos y si está aprobado
// }

//   review: { "idModulo:leccion:paso": {box, due} }   cola de repaso: caja Leitner (0-3) y fecha del próximo repaso
const emptyProgress = () => ({ done: [], xp: 0, streak: 0, lastDay: null, scores: {}, mods: {}, review: {} })

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

function Home({ progress, onOpen, onReset, onReview }) {
  const pending = pendingIds(progress).length
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
      <div className="options">
        {courses.map((c) => {
          const approved = approvedCount(c, progress)
          return (
            <button key={c.id} className="btn module-btn course-btn" onClick={() => onOpen(c.id)}>
              {c.recommended && <span className="badge">Recomendado primero</span>}
              <span className="module-title">{c.title}</span>
              <span className="module-desc">{c.description}</span>
              <span className="module-status">
                {approved} de {c.modules.length} módulos aprobados
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
          {approvedCount(c, progress)} de {c.modules.length} módulos aprobados
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
      <p className="hint center">Para aprobar un módulo necesitas {pctText(MIN_APROBACION)} de aciertos a la primera.</p>
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
  const [queue, setQueue] = useState(() => lesson.steps.map((s, i) => ({ s, i, retry: false })))
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok }
  const [correct, setCorrect] = useState(0) // aciertos a la primera
  const [finished, setFinished] = useState(false)

  const totalExercises = useMemo(
    () => lesson.steps.filter((s) => !['card', 'lab'].includes(s.type)).length,
    [lesson],
  )

  const earned = correct * XP_PER_EXERCISE + XP_LESSON_BONUS

  const item = queue[idx]

  const handleDone = (ok) => {
    setAnswer({ ok })
    if (!item.retry) {
      if (ok) setCorrect((c) => c + 1)
      else {
        setQueue((q) => [...q, { s: item.s, i: item.i, retry: true }])
        onFail(item.i) // fallo a la primera: entra a la cola de repaso
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
    const modPct = isLast ? modulePercent(mod, progress.scores) : null
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
        ) : s.type === 'lab' ? (
          <Lab key={`${idx}`} step={s} onComplete={advance} />
        ) : (
          <Exercise key={`${idx}`} step={s} onDone={handleDone} />
        )}

        {s.type === 'card' && (
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

function ReviewPlayer({ items, progress, onAnswer, onFinish, onExit }) {
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok }
  const [hits, setHits] = useState(0)
  const [finished, setFinished] = useState(false)

  const item = items[idx]

  const handleDone = (ok) => {
    setAnswer({ ok })
    if (ok) setHits((h) => h + 1)
    onAnswer(item.id, ok) // la caja y la fecha se guardan en cada respuesta
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
            Subieron de caja: {hits}. Volverán a la caja inicial: {items.length - hits}.
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
      <p className="lesson-title">Repaso del día · {item.modTitle}</p>

      <section className="card">
        <Exercise key={idx} step={s} onDone={handleDone} />
        {answer && (
          <>
            <div className={`feedback ${answer.ok ? 'ok' : 'bad'}`}>
              <strong>{answer.ok ? '¡Correcto!' : 'Casi. Volverá a salir mañana.'}</strong>
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

  if (view.name === 'course') {
    const c = courses.find((x) => x.id === view.courseId)
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
