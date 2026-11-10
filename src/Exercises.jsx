import { useEffect, useRef, useState } from 'react'

// ---------- Voz del navegador (speechSynthesis, inglés) ----------
const englishVoices = () => {
  try {
    return (window.speechSynthesis?.getVoices() || []).filter((v) => /^en([-_]|$)/i.test(v.lang))
  } catch {
    return []
  }
}

export const hasEnglishVoice = () => englishVoices().length > 0

// Algunos navegadores cargan la lista de voces de forma asíncrona: se pide pronto.
try {
  window.speechSynthesis?.getVoices()
} catch {
  // sin síntesis de voz
}

export function useEnglishVoice() {
  const [ok, setOk] = useState(hasEnglishVoice)
  useEffect(() => {
    const ss = window.speechSynthesis
    if (!ss) return undefined
    const update = () => setOk(hasEnglishVoice())
    update()
    ss.addEventListener?.('voiceschanged', update)
    return () => ss.removeEventListener?.('voiceschanged', update)
  }, [])
  return ok
}

export function speak(text) {
  try {
    const ss = window.speechSynthesis
    if (!ss) return
    ss.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    const voices = englishVoices()
    const voice = voices.find((v) => /^en[-_]US$/i.test(v.lang)) || voices[0]
    if (voice) u.voice = voice
    ss.speak(u)
  } catch {
    // sin audio
  }
}

export function shuffle(arr) {
  const r = [...arr]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

function shuffleDifferent(arr) {
  if (arr.length < 2) return [...arr]
  let r = shuffle(arr)
  let tries = 0
  while (r.every((x, i) => x === arr[i]) && tries++ < 20) r = shuffle(arr)
  return r
}

export function Card({ step }) {
  return (
    <div className="card-step">
      <div className="emoji">{step.emoji}</div>
      <p className="card-text">{step.text}</p>
      {step.analogy && <p className="analogy">{step.analogy}</p>}
    </div>
  )
}

// Mezcla las opciones una sola vez al montar el ejercicio (useState inicial)
// y marca la correcta por contenido, no por posición.
// Si el ejercicio trae "accept" (traducciones válidas: la principal y sus variantes), una opción
// es correcta si su texto coincide con cualquiera de ellas; si no, solo la del índice "answer".
function useShuffledOptions(step) {
  const [opts] = useState(() => {
    const accepted = step.accept?.map((a) => a.trim().toLowerCase())
    return shuffle(
      step.options.map((text, i) => ({
        text,
        correct: accepted ? accepted.includes(text.trim().toLowerCase()) : i === step.answer,
      })),
    )
  })
  return opts
}

export function Choice({ step, onDone }) {
  const opts = useShuffledOptions(step)
  const [picked, setPicked] = useState(null) // índice dentro de opts (ya mezclado)
  const choose = (i) => {
    if (picked !== null) return
    setPicked(i)
    onDone(opts[i].correct)
  }
  return (
    <>
      <h2>{step.q}</h2>
      <div className="options">
        {opts.map((opt, i) => {
          let cls = 'btn option'
          if (picked !== null) {
            if (opt.correct) cls += ' correct'
            else if (i === picked) cls += ' wrong'
          }
          return (
            <button key={opt.text} className={cls} disabled={picked !== null} onClick={() => choose(i)}>
              {opt.text}
            </button>
          )
        })}
      </div>
    </>
  )
}

export function TrueFalse({ step, onDone }) {
  const [picked, setPicked] = useState(null)
  const choose = (v) => {
    if (picked !== null) return
    setPicked(v)
    onDone(v === step.answer)
  }
  return (
    <>
      <p className="tf-label">¿Verdadero o falso?</p>
      <h2>{step.statement}</h2>
      <div className="options tf">
        {[true, false].map((v) => {
          let cls = 'btn option'
          if (picked !== null) {
            if (v === step.answer) cls += ' correct'
            else if (v === picked) cls += ' wrong'
          }
          return (
            <button key={String(v)} className={cls} disabled={picked !== null} onClick={() => choose(v)}>
              {v ? 'Verdadero' : 'Falso'}
            </button>
          )
        })}
      </div>
    </>
  )
}

export function Order({ step, onDone }) {
  const [pool] = useState(() => shuffleDifferent(step.items))
  const [chosen, setChosen] = useState([])
  const [result, setResult] = useState(null)

  const tap = (item) => {
    if (result !== null || chosen.includes(item)) return
    const next = [...chosen, item]
    setChosen(next)
    if (next.length === pool.length) {
      const ok = next.every((x, i) => x === step.items[i])
      setResult(ok)
      onDone(ok)
    }
  }
  const undo = () => {
    if (result === null) setChosen((c) => c.slice(0, -1))
  }

  return (
    <>
      <h2>{step.q}</h2>
      <p className="hint">Toca los elementos en el orden correcto</p>
      <ol className="order-slots">
        {pool.map((_, i) => {
          const item = chosen[i]
          let cls = 'slot'
          if (result !== null && item) cls += item === step.items[i] ? ' correct' : ' wrong'
          return (
            <li key={i} className={cls}>
              {item ?? ''}
            </li>
          )
        })}
      </ol>
      <div className="options">
        {pool.map((item) => (
          <button
            key={item}
            className="btn option"
            disabled={chosen.includes(item) || result !== null}
            onClick={() => tap(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {result === null && chosen.length > 0 && (
        <button className="btn" onClick={undo}>
          Deshacer
        </button>
      )}
      {result === false && (
        <p className="hint">
          Orden correcto: {step.items.map((x, i) => `${i + 1}. ${x}`).join('  ')}
        </p>
      )}
    </>
  )
}

export function Match({ step, onDone }) {
  const [rights] = useState(() => shuffle(step.pairs.map((p) => p.desc)))
  const [lefts] = useState(() => shuffle(step.pairs.map((_, i) => i)))
  const [sel, setSel] = useState(null)
  const [matched, setMatched] = useState([])
  const [flash, setFlash] = useState(null)
  const mistakes = useRef(0) // toques equivocados; se informan para dar puntaje parcial en el examen
  const wrongTerms = useRef(new Set()) // índices de pares en los que hubo un toque equivocado

  const tapTerm = (i) => {
    if (matched.includes(i)) return
    setSel(i)
  }
  const tapDesc = (d) => {
    if (sel === null) return
    if (step.pairs[sel].desc === d) {
      const nm = [...matched, sel]
      setMatched(nm)
      setSel(null)
      if (nm.length === step.pairs.length) onDone(mistakes.current === 0, { mistakes: mistakes.current, wrongTerms: [...wrongTerms.current] })
    } else {
      mistakes.current += 1
      wrongTerms.current.add(sel)
      setFlash(d)
      setSel(null)
      setTimeout(() => setFlash(null), 600)
    }
  }
  const matchedDescs = matched.map((i) => step.pairs[i].desc)

  return (
    <>
      <h2>{step.q}</h2>
      <p className="hint">Toca un concepto y luego su descripción</p>
      <div className="match-grid">
        <div className="options">
          {lefts.map((i) => {
            const p = step.pairs[i]
            let cls = 'btn option'
            if (matched.includes(i)) cls += ' correct'
            else if (sel === i) cls += ' selected'
            return (
              <button key={p.term} className={cls} disabled={matched.includes(i)} onClick={() => tapTerm(i)}>
                {p.term}
              </button>
            )
          })}
        </div>
        <div className="options">
          {rights.map((d) => {
            let cls = 'btn option'
            if (matchedDescs.includes(d)) cls += ' correct'
            else if (flash === d) cls += ' wrong'
            return (
              <button key={d} className={cls} disabled={matchedDescs.includes(d)} onClick={() => tapDesc(d)}>
                {d}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

export function Scenario({ step, onDone }) {
  return (
    <>
      <div className="scenario">
        <span className="scenario-tag">🧩 Caso</span>
        <p>{step.situation}</p>
      </div>
      <Choice step={step} onDone={onDone} />
    </>
  )
}

export function FindBug({ step, onDone }) {
  const [picked, setPicked] = useState(null)
  const bad = Array.isArray(step.answer) ? step.answer : [step.answer]
  const tap = (i) => {
    if (picked !== null) return
    setPicked(i)
    onDone(bad.includes(i))
  }
  return (
    <>
      <h2>{step.q}</h2>
      <p className="hint">{step.hint || 'Toca la línea insegura'}</p>
      <div className="code">
        {step.lines.map((line, i) => {
          let cls = 'code-line'
          if (picked !== null) {
            if (bad.includes(i)) cls += ' correct'
            else if (i === picked) cls += ' wrong'
          }
          return (
            <button key={i} className={cls} disabled={picked !== null} onClick={() => tap(i)}>
              {line}
            </button>
          )
        })}
      </div>
    </>
  )
}

export function FillBlank({ step, onDone }) {
  const opts = useShuffledOptions(step)
  const [picked, setPicked] = useState(null)
  const choose = (i) => {
    if (picked !== null) return
    setPicked(i)
    onDone(opts[i].correct)
  }
  const [before, after] = step.code.split('___')
  const shown = picked === null ? '___' : opts[picked].text
  const blankCls =
    picked === null ? 'blank' : opts[picked].correct ? 'blank correct' : 'blank wrong'
  return (
    <>
      <h2>{step.q}</h2>
      <pre className="code-block">
        {before}
        <span className={blankCls}>{shown}</span>
        {after}
      </pre>
      <div className="options">
        {opts.map((opt, i) => {
          let cls = 'btn option'
          if (picked !== null) {
            if (opt.correct) cls += ' correct'
            else if (i === picked) cls += ' wrong'
          }
          return (
            <button key={opt.text} className={cls} disabled={picked !== null} onClick={() => choose(i)}>
              {opt.text}
            </button>
          )
        })}
      </div>
    </>
  )
}

const BUDGET_URL =
  'https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html'

export function Lab({ step, onComplete }) {
  const [ack, setAck] = useState(false)
  const [checked, setChecked] = useState([])
  const steps = step.steps || []
  const allDone = checked.length === steps.length
  const toggle = (i) =>
    setChecked((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]))

  return (
    <>
      <p className="scenario-tag">🧪 Lab práctico</p>
      <h2>{step.title}</h2>
      <p>
        <strong>Objetivo:</strong> {step.objective}
      </p>

      {step.local ? (
        <div className="lab-warning">
          <strong>💻 Lab local, solo en tu computadora</strong>
          <ul>
            <li>Se hace únicamente en tu computadora, no en la nube de AWS: no genera costos de AWS.</li>
            <li>Es opcional: puedes saltarlo y hacerlo más tarde.</li>
            <li>No guardes claves ni contraseñas reales en archivos de práctica.</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>Lo entendí</span>
          </label>
        </div>
      ) : (
      <div className="lab-warning">
        <strong>⚠️ Antes de empezar: costos y seguridad</strong>
        <ul>
          <li>Esto se hace en una cuenta real de AWS: algunos servicios pueden generar costos.</li>
          <li>
            Crea primero una alerta de presupuesto: en AWS Budgets, Create budget → Use a template
            (simplified) → Zero spend budget → Create budget (avisa cuando el gasto supera los límites
            del Free Tier).{' '}
            <a href={BUDGET_URL} target="_blank" rel="noreferrer">
              Documentación
            </a>
          </li>
          <li>No guardes access keys reales en el código ni en el repositorio.</li>
          <li>Al terminar, elimina lo que hayas creado (ver «Limpieza»).</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>Lo entendí y ya tengo mi alerta de presupuesto</span>
        </label>
      </div>
      )}

      {ack && (
        <>
          {steps.length > 0 ? (
            <ol className="lab-steps">
              {steps.map((s, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={checked.includes(i)} onChange={() => toggle(i)} />
                    <span>{s}</span>
                  </label>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">
              No pude verificar los pasos exactos de la consola, así que solo queda el objetivo. Sigue
              la documentación oficial.
            </p>
          )}
          {step.cleanup && (
            <p className="lab-cleanup">
              <strong>Limpieza:</strong> {step.cleanup}
            </p>
          )}
          <button className="btn primary" disabled={!allDone} onClick={onComplete}>
            Lab terminado
          </button>
        </>
      )}
      <button className="btn" onClick={onComplete}>
        Hacerlo más tarde
      </button>
    </>
  )
}

// Tarjeta de vocabulario: inglés, traducción, emoji y ejemplo.
export function WordCard({ step }) {
  const voice = useEnglishVoice()
  return (
    <div className="card-step">
      <div className="emoji">{step.emoji}</div>
      <p className="word-en">
        {step.en}
        {voice && (
          <button className="speak" onClick={() => speak(step.en)} aria-label={`Escuchar ${step.en}`}>
            🔊
          </button>
        )}
      </p>
      <p className="word-es">
        {step.es}
        {step.alt?.length > 0 && <span className="word-alt"> ({step.alt.join(', ')})</span>}
      </p>
    </div>
  )
}

// Se reproduce la palabra y se elige cuál es (solo si hay voz en inglés).
export function Listen({ step, onDone }) {
  const opts = useShuffledOptions(step)
  const [picked, setPicked] = useState(null)
  useEffect(() => {
    speak(step.word)
  }, [step.word])
  const choose = (i) => {
    if (picked !== null) return
    setPicked(i)
    onDone(opts[i].correct)
  }
  return (
    <>
      <h2>Escucha y elige la palabra</h2>
      <button className="btn" onClick={() => speak(step.word)}>
        🔊 Escuchar otra vez
      </button>
      <div className="options">
        {opts.map((opt, i) => {
          let cls = 'btn option'
          if (picked !== null) {
            if (opt.correct) cls += ' correct'
            else if (i === picked) cls += ' wrong'
          }
          return (
            <button key={opt.text} className={cls} disabled={picked !== null} onClick={() => choose(i)}>
              {opt.text}
            </button>
          )
        })}
      </div>
    </>
  )
}

// Escribir la palabra en inglés viendo la traducción.
// Acepta mayúsculas/minúsculas y espacios de más; no ignora acentos ni letras distintas.
const normalizeTyped = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export function TypeAnswer({ step, onDone }) {
  const [value, setValue] = useState('')
  const [done, setDone] = useState(false)
  const submit = () => {
    if (done || !value.trim()) return
    setDone(true)
    onDone(normalizeTyped(value) === normalizeTyped(step.answer))
  }
  return (
    <>
      <h2>Escribe la palabra en inglés</h2>
      <div className="type-prompt">
        <span className="emoji-sm">{step.emoji}</span> {step.es}
      </div>
      <input
        className="type-input"
        value={value}
        disabled={done}
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="English word"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {!done && (
        <button className="btn primary" disabled={!value.trim()} onClick={submit}>
          Comprobar
        </button>
      )}
    </>
  )
}

export const exerciseComponents = {
  choice: Choice,
  truefalse: TrueFalse,
  order: Order,
  match: Match,
  scenario: Scenario,
  findbug: FindBug,
  fillblank: FillBlank,
  listen: Listen,
  type: TypeAnswer,
}
