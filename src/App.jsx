import { useMemo, useState } from 'react'
import course from './data/course.json'
import { Card, Lab, exerciseComponents } from './Exercises'

const moduleFiles = import.meta.glob('./data/modules/*.json', {
  eager: true,
  import: 'default',
})

const STORAGE_KEY = 'cloudsec-progress-v2' // lista de "idModulo:indiceLeccion"

const modules = course.modules.map((m) => ({
  ...m,
  data: moduleFiles[`./data/modules/${m.file}`],
}))

const lessonKey = (modId, i) => `${modId}:${i}`

function loadDone() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []
  } catch {
    return []
  }
}

function saveDone(done) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(done))
  } catch {
    // sin almacenamiento: el progreso solo dura la sesión
  }
}

const moduleDone = (m, done) =>
  m.data.lessons.every((_, i) => done.includes(lessonKey(m.id, i)))

const moduleUnlocked = (idx, done) => idx === 0 || moduleDone(modules[idx - 1], done)

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

function Home({ done, onOpen }) {
  return (
    <main className="app">
      <header>
        <p className="module">Cloud Security</p>
        <h1>Módulos</h1>
      </header>
      <div className="options">
        {modules.map((m, i) => {
          const unlocked = moduleUnlocked(i, done)
          const finished = moduleDone(m, done)
          const count = m.data.lessons.filter((_, j) => done.includes(lessonKey(m.id, j))).length
          return (
            <button
              key={m.id}
              className={`btn module-btn${unlocked ? '' : ' locked'}${finished ? ' finished' : ''}`}
              disabled={!unlocked}
              onClick={() => onOpen(m.id)}
            >
              <span className="module-title">
                {!unlocked && '🔒 '}
                {finished && '✓ '}
                {m.title}
              </span>
              <span className="module-desc">
                {unlocked
                  ? `${m.description} · ${count}/${m.data.lessons.length} lecciones`
                  : 'Termina el módulo anterior para desbloquear'}
              </span>
            </button>
          )
        })}
      </div>
    </main>
  )
}

function LessonList({ mod, done, onOpen, onBack }) {
  return (
    <main className="app">
      <header>
        <button className="back" onClick={onBack}>
          ← Módulos
        </button>
        <h1>{mod.title}</h1>
      </header>
      <div className="options">
        {mod.data.lessons.map((l, i) => {
          const finished = done.includes(lessonKey(mod.id, i))
          const unlocked = i === 0 || done.includes(lessonKey(mod.id, i - 1))
          return (
            <button
              key={i}
              className={`btn module-btn${unlocked ? '' : ' locked'}${finished ? ' finished' : ''}`}
              disabled={!unlocked}
              onClick={() => onOpen(i)}
            >
              <span className="module-title">
                {!unlocked && '🔒 '}
                {finished && '✓ '}
                {i + 1}. {l.title}
              </span>
            </button>
          )
        })}
      </div>
    </main>
  )
}

function Player({ lesson, hasNext, onExit, onFinish, onNext, onRepeat }) {
  const [queue, setQueue] = useState(() => lesson.steps.map((s) => ({ s, retry: false })))
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState(null) // null | { ok }
  const [correct, setCorrect] = useState(0)
  const [finished, setFinished] = useState(false)

  const totalExercises = useMemo(
    () => lesson.steps.filter((s) => !['card', 'lab'].includes(s.type)).length,
    [lesson],
  )

  const item = queue[idx]

  const handleDone = (ok) => {
    setAnswer({ ok })
    if (!item.retry) {
      if (ok) setCorrect((c) => c + 1)
      else setQueue((q) => [...q, { s: item.s, retry: true }])
    }
  }

  const advance = () => {
    setAnswer(null)
    if (idx + 1 >= queue.length) {
      setFinished(true)
      onFinish()
    } else {
      setIdx(idx + 1)
    }
  }

  const pct = finished ? 100 : Math.round((idx / queue.length) * 100)

  if (finished) {
    return (
      <main className="app">
        <section className="card result">
          <h2>¡Lección completada!</h2>
          <p className="score">
            {correct} / {totalExercises}
          </p>
          <p>aciertos a la primera</p>
          {hasNext && (
            <button className="btn primary" onClick={onNext}>
              Siguiente lección
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

function App() {
  const [done, setDone] = useState(loadDone)
  const [view, setView] = useState({ name: 'home' }) // home | module | lesson

  const markDone = (key) =>
    setDone((d) => {
      if (d.includes(key)) return d
      const nd = [...d, key]
      saveDone(nd)
      return nd
    })

  if (view.name === 'home') {
    return <Home done={done} onOpen={(modId) => setView({ name: 'module', modId })} />
  }

  const mod = modules.find((m) => m.id === view.modId)

  if (view.name === 'module') {
    return (
      <LessonList
        mod={mod}
        done={done}
        onBack={() => setView({ name: 'home' })}
        onOpen={(i) => setView({ name: 'lesson', modId: mod.id, i, nonce: 0 })}
      />
    )
  }

  const lesson = mod.data.lessons[view.i]
  const hasNext = view.i + 1 < mod.data.lessons.length

  return (
    <Player
      key={`${mod.id}-${view.i}-${view.nonce}`}
      lesson={lesson}
      hasNext={hasNext}
      onExit={() => setView({ name: 'module', modId: mod.id })}
      onFinish={() => markDone(lessonKey(mod.id, view.i))}
      onNext={() => setView({ name: 'lesson', modId: mod.id, i: view.i + 1, nonce: 0 })}
      onRepeat={() => setView({ ...view, nonce: view.nonce + 1 })}
    />
  )
}

export default App
