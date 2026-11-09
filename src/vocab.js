// Generación de ejercicios de vocabulario a partir de las palabras (no se escriben a mano).
import { shuffle, hasEnglishVoice } from './Exercises'

export { hasEnglishVoice }

const norm = (s) => s.trim().toLowerCase()
const pick = (arr, n) => shuffle(arr).slice(0, n)

export const moduleWords = (mod) => mod.data.sessions.flatMap((s) => s.words)

// Busca la palabra exacta (palabra completa, sin importar mayúsculas) en una oración.
// Devuelve el texto tal como aparece o null (por ejemplo, "passwords" no cuenta para "password").
function findExact(sentence, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = sentence.match(new RegExp(`(^|[^A-Za-z])(${esc})(?![A-Za-z])`, 'i'))
  return m ? { text: m[2], index: m.index + m[1].length } : null
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// Regla de traducciones: "es" es la principal (español de México cuando hay variantes regionales)
// y es la que se muestra en los ejercicios; "alt" (opcional) son variantes comunes que la tarjeta
// muestra entre paréntesis y que se aceptan como correctas donde se elige o escribe una traducción.
const acceptedEs = (word) => [word.es, ...(word.alt || [])]
const altNote = (word) => (word.alt?.length ? ` (también: ${word.alt.join(', ')})` : '')

function genChoice(word, pool) {
  const accepted = acceptedEs(word).map(norm)
  // Ningún distractor puede ser una traducción aceptada de la palabra.
  const wrong = pick(
    [...new Set(pool.map((w) => w.es))].filter((es) => !accepted.includes(norm(es))),
    2,
  )
  return {
    type: 'choice',
    gen: 'choice',
    q: `¿Qué significa «${word.en}»?`,
    options: [word.es, ...wrong],
    answer: 0,
    accept: acceptedEs(word),
    why: `«${word.en}» significa «${word.es}»${altNote(word)}.`,
  }
}

function genFill(word, pool) {
  const found = findExact(word.exampleEn, word.en)
  if (!found) return null
  const upper = found.text[0] !== found.text[0].toLowerCase()
  const wrong = pick(
    pool.map((w) => w.en).filter((en) => norm(en) !== norm(word.en) && !findExact(word.exampleEn, en)),
    2,
  ).map((en) => (upper ? capitalize(en) : en))
  const code =
    word.exampleEn.slice(0, found.index) + '___' + word.exampleEn.slice(found.index + found.text.length)
  return {
    type: 'fillblank',
    gen: 'fillblank',
    q: `Completa la oración: ${word.exampleEs}`,
    code,
    options: [found.text, ...wrong],
    answer: 0,
    why: `La palabra es «${found.text}» (${word.es}).`,
  }
}

function genListen(word, pool) {
  const wrong = pick(
    pool.map((w) => w.en).filter((en) => norm(en) !== norm(word.en)),
    2,
  )
  return {
    type: 'listen',
    gen: 'listen',
    word: word.en,
    options: [word.en, ...wrong],
    answer: 0,
    why: `Escuchaste «${word.en}» (${word.es}).`,
  }
}

function genType(word) {
  return {
    type: 'type',
    gen: 'type',
    es: word.es,
    emoji: word.emoji,
    answer: word.en,
    why: `Se escribe «${word.en}» (${word.es}${word.alt?.length ? `; también: ${word.alt.join(', ')}` : ''}).`,
  }
}

function genMatch(words) {
  return {
    type: 'match',
    gen: 'match',
    q: 'Une cada palabra con su traducción',
    pairs: words.map((w) => ({ term: w.en, desc: w.es })),
    why: words.map((w) => `${w.en} = ${w.es}${w.alt?.length ? ` (${w.alt.join(', ')})` : ''}`).join(' · '),
  }
}

const wordCard = (w) => ({
  type: 'wordcard',
  emoji: w.emoji,
  en: w.en,
  es: w.es,
  alt: w.alt || [],
  exampleEn: w.exampleEn,
  exampleEs: w.exampleEs,
})

// Sesión de aprendizaje: grupos de 2 tarjetas + 1 ejercicio rápido (nunca más de 2 tarjetas
// seguidas); al final, repaso de todas las palabras: unir (de 5 en 5) y escribir cada palabra.
export function buildSessionSteps(session, mod, voice = hasEnglishVoice()) {
  const pool = moduleWords(mod)
  const words = session.words
  const cycle = voice ? ['choice', 'fillblank', 'listen'] : ['choice', 'fillblank']
  const steps = []
  for (let g = 0; g * 2 < words.length; g++) {
    const group = words.slice(g * 2, g * 2 + 2)
    group.forEach((w) => steps.push(wordCard(w)))
    const target = group[g % group.length]
    const kind = cycle[g % cycle.length]
    const ex =
      (kind === 'fillblank' && genFill(target, pool)) ||
      (kind === 'listen' && genListen(target, pool)) ||
      genChoice(target, pool)
    steps.push(ex)
  }
  for (let i = 0; i < words.length; i += 5) {
    const chunk = words.slice(i, i + 5)
    if (chunk.length >= 3) steps.push(genMatch(chunk))
  }
  shuffle(words).forEach((w) => steps.push(genType(w)))
  return steps
}

// Un ejercicio para repasar una palabra; evita repetir el tipo usado la vez anterior.
export function buildReviewStep(word, mod, last, voice = hasEnglishVoice()) {
  const pool = moduleWords(mod)
  const makers = {
    choice: () => genChoice(word, pool),
    fillblank: () => genFill(word, pool),
    listen: () => (voice ? genListen(word, pool) : null),
    type: () => genType(word),
  }
  const available = Object.keys(makers).filter((k) => makers[k]() !== null)
  const options = available.filter((k) => k !== last)
  const kind = pick(options.length ? options : available, 1)[0]
  return makers[kind]()
}

// ---------- Examen de nivel ----------
// Muestreo ponderado sin reemplazo (Efraimidis-Spirakis): mayor peso = más probabilidad.
function weightedSample(entries, n) {
  return entries
    .map((e) => ({ e, k: Math.random() ** (1 / e.weight) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, n)
    .map((x) => x.e)
}

// entries: [{ id, word, mod, weight }]. Si hay menos de `size`, usa todas.
// Devuelve ítems { step, weight, modTitle } mezclados; el puntaje total es la suma de pesos.
// Un ejercicio de unir vale tantos puntos como palabras une (con puntaje parcial según errores).
export function buildExam(entries, voice = hasEnglishVoice(), size = 20) {
  const chosen = weightedSample(entries, size)
  const items = []

  const matchEntries = []
  if (chosen.length >= 8) {
    const seen = new Set()
    for (const c of chosen) {
      if (matchEntries.length === 5) break
      // Sin traducciones repetidas ni cruzadas (principal o variante) dentro del mismo unir.
      const names = acceptedEs(c.word).map(norm)
      if (!names.some((n) => seen.has(n))) {
        names.forEach((n) => seen.add(n))
        matchEntries.push(c)
      }
    }
    if (matchEntries.length === 5) {
      items.push({
        step: genMatch(matchEntries.map((c) => c.word)),
        weight: 5,
        modTitle: 'Examen de nivel',
      })
    } else {
      matchEntries.length = 0
    }
  }

  const rest = chosen.filter((c) => !matchEntries.includes(c))
  const cycle = voice ? ['choice', 'listen', 'type', 'fillblank'] : ['choice', 'type', 'fillblank']
  rest.forEach((c, i) => {
    const pool = moduleWords(c.mod)
    const kind = cycle[i % cycle.length]
    const step =
      (kind === 'listen' && genListen(c.word, pool)) ||
      (kind === 'type' && genType(c.word)) ||
      (kind === 'fillblank' && genFill(c.word, pool)) ||
      genChoice(c.word, pool)
    items.push({ step, weight: 1, modTitle: c.mod.title })
  })
  return shuffle(items)
}
