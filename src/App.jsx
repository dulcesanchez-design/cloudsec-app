import { useState } from 'react'
import course from './data/course.json'

const moduleFiles = import.meta.glob('./data/modules/*.json', {
  eager: true,
  import: 'default',
})

const STORAGE_KEY = 'cloudsec-progress'

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
        <p className="progress">
          {done.length} de {course.modules.length} completados
        </p>
      </header>
      <div className="options">
        {course.modules.map((m, i) => {
          const unlocked = i === 0 || done.includes(course.modules[i - 1].id)
          const finished = done.includes(m.id)
          return (
            <button
              key={m.id}
              className={`btn module-btn${unlocked ? '' : ' locked'}${finished ? ' finished' : ''}`}
              disabled={!unlocked}
              onClick={() => onOpen(m)}
            >
              <span className="module-title">
                {!unlocked && '🔒 '}
                {finished && '✓ '}
                {m.title}
              </span>
              <span className="module-desc">
                {unlocked ? m.description : 'Termina el módulo anterior para desbloquear'}
              </span>
            </button>
          )
        })}
      </div>
    </main>
  )
}

function Lesson({ mod, onExit, onFinish }) {
  const [lessonIdx, setLessonIdx] = useState(0)
  const [step, setStep] = useState(-1) // -1 = explicación, 0..n-1 = preguntas, n = resultado
  const [picked, setPicked] = useState(null)
  const [score, setScore] = useState(0)

  const lesson = mod.lessons[lessonIdx]
  const total = lesson.questions.length
  const isLast = lessonIdx === mod.lessons.length - 1

  const resetLesson = (idx) => {
    setLessonIdx(idx)
    setStep(-1)
    setPicked(null)
    setScore(0)
  }

  const choose = (i) => {
    if (picked !== null) return
    setPicked(i)
    if (i === lesson.questions[step].answer) setScore((s) => s + 1)
  }

  const next = () => {
    setPicked(null)
    if (step + 1 === total && isLast) onFinish()
    setStep((s) => s + 1)
  }

  return (
    <main className="app">
      <header>
        <button className="back" onClick={onExit}>
          ← Módulos
        </button>
        <p className="module">{mod.title}</p>
        <h1>{lesson.title}</h1>
        <p className="progress">
          Lección {lessonIdx + 1} de {mod.lessons.length}
        </p>
      </header>

      {step === -1 && (
        <section className="card">
          {lesson.term && (
            <p className="term">
              Término nuevo: <strong>{lesson.term}</strong>
            </p>
          )}
          <p className="explanation">{lesson.explanation}</p>
          <Sources source={lesson.source} />
          <button className="btn primary" onClick={() => setStep(0)}>
            Empezar preguntas
          </button>
        </section>
      )}

      {step >= 0 && step < total && (
        <section className="card">
          <p className="progress">
            Pregunta {step + 1} de {total}
          </p>
          <h2>{lesson.questions[step].q}</h2>
          <div className="options">
            {lesson.questions[step].options.map((opt, i) => {
              const { answer } = lesson.questions[step]
              let cls = 'btn option'
              if (picked !== null) {
                if (i === answer) cls += ' correct'
                else if (i === picked) cls += ' wrong'
              }
              return (
                <button
                  key={i}
                  className={cls}
                  onClick={() => choose(i)}
                  disabled={picked !== null}
                >
                  {opt}
                </button>
              )
            })}
          </div>
          {picked !== null && (
            <>
              <p className="why">{lesson.questions[step].why}</p>
              <button className="btn primary" onClick={next}>
                {step + 1 === total ? 'Ver resultado' : 'Continuar'}
              </button>
            </>
          )}
        </section>
      )}

      {step === total && (
        <section className="card result">
          <h2>Resultado</h2>
          <p className="score">
            {score} / {total}
          </p>
          <p>
            {score === total
              ? '¡Perfecto!'
              : score >= total / 2
                ? 'Bien, pero puedes repasar.'
                : 'Repite la lección para afianzar los conceptos.'}
          </p>
          {!isLast && (
            <button
              className="btn primary"
              onClick={() => resetLesson(lessonIdx + 1)}
            >
              Siguiente lección
            </button>
          )}
          <button className="btn" onClick={() => resetLesson(lessonIdx)}>
            Repetir lección
          </button>
          <button className="btn" onClick={onExit}>
            {isLast ? 'Módulo completado: volver al inicio' : 'Volver a los módulos'}
          </button>
        </section>
      )}
    </main>
  )
}

function App() {
  const [done, setDone] = useState(loadDone)
  const [current, setCurrent] = useState(null)

  const markDone = (id) => {
    setDone((d) => {
      if (d.includes(id)) return d
      const nd = [...d, id]
      saveDone(nd)
      return nd
    })
  }

  if (!current) {
    return (
      <Home
        done={done}
        onOpen={(m) =>
          setCurrent({ id: m.id, data: moduleFiles[`./data/modules/${m.file}`] })
        }
      />
    )
  }

  return (
    <Lesson
      key={current.id}
      mod={current.data}
      onExit={() => setCurrent(null)}
      onFinish={() => markDone(current.id)}
    />
  )
}

export default App
