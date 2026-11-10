// Generación de ejercicios de vocabulario a partir de las palabras (no se escriben a mano).
// Una palabra tiene solo: en, es, emoji y, si aplica, alt (variantes de la traducción).
// Tipos de ejercicio del curso de inglés: choice, match, listen y type.
import { shuffle, hasEnglishVoice } from './Exercises'

export { hasEnglishVoice }

const norm = (s) => s.trim().toLowerCase()
const pick = (arr, n) => shuffle(arr).slice(0, n)

export const moduleWords = (mod) => mod.data.sessions.flatMap((s) => s.words)

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

// Tarjeta: solo palabra en inglés, traducción (con variante), emoji y audio.
const wordCard = (w) => ({
  type: 'wordcard',
  emoji: w.emoji,
  en: w.en,
  es: w.es,
  alt: w.alt || [],
})

// Ejercicio individual (choice, listen o type) para una palabra.
function makeSingle(kind, word, pool) {
  if (kind === 'listen') return genListen(word, pool)
  if (kind === 'type') return genType(word)
  return genChoice(word, pool)
}

// Sesión de aprendizaje: grupos de 2 tarjetas seguidos de 2 ejercicios (uno por palabra, alternando
// choice, listen y type; nunca más de 2 tarjetas seguidas) y, al final, unir de 5 en 5 con todas las
// palabras. Cada palabra se practica al menos dos veces: su ejercicio individual y su unir.
export function buildSessionSteps(session, mod, voice = hasEnglishVoice()) {
  const pool = moduleWords(mod)
  const words = session.words
  const cycle = voice ? ['choice', 'listen', 'type'] : ['choice', 'type']
  const steps = []
  let n = 0
  for (let g = 0; g * 2 < words.length; g++) {
    const group = words.slice(g * 2, g * 2 + 2)
    group.forEach((w) => steps.push(wordCard(w)))
    group.forEach((w) => steps.push(makeSingle(cycle[n++ % cycle.length], w, pool)))
  }
  const chunks = []
  for (let i = 0; i < words.length; i += 5) chunks.push(words.slice(i, i + 5))
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 3) {
    chunks[chunks.length - 2].push(...chunks.pop())
  }
  chunks.forEach((c) => steps.push(genMatch(c)))
  return steps
}

// Repaso por palabra. entries: [{ id, word, mod, last }] (last = tipo usado la vez anterior).
// A cada palabra le toca un tipo distinto del anterior (choice, listen, type o match). Las que
// reciben «unir» se agrupan (de 3 a 5 palabras, sin traducciones repetidas ni cruzadas); si una
// agrupación queda con menos de 3, esas palabras pasan a choice.
// Devuelve ítems { id, step, modTitle } o, para unir, { ids, step, modTitle }.
export function buildReviewItems(entries, voice = hasEnglishVoice()) {
  const kinds = voice ? ['choice', 'listen', 'type', 'match'] : ['choice', 'type', 'match']
  const planned = entries.map((e) => {
    const options = kinds.filter((k) => k !== e.last)
    return { ...e, kind: pick(options.length ? options : kinds, 1)[0] }
  })

  const groups = []
  for (const p of planned.filter((x) => x.kind === 'match')) {
    const names = acceptedEs(p.word).map(norm)
    const target = groups.find(
      (g) => g.members.length < 5 && !names.some((nm) => g.names.has(nm)),
    )
    if (target) {
      target.members.push(p)
      names.forEach((nm) => target.names.add(nm))
    } else {
      groups.push({ members: [p], names: new Set(names) })
    }
  }

  const items = []
  for (const g of groups) {
    if (g.members.length >= 3) {
      items.push({
        ids: g.members.map((m) => m.id),
        step: genMatch(g.members.map((m) => m.word)),
        modTitle: 'Vocabulario',
      })
    } else {
      g.members.forEach((m) => (m.kind = 'choice'))
    }
  }
  for (const p of planned) {
    if (p.kind === 'match' && groups.some((g) => g.members.length >= 3 && g.members.includes(p))) continue
    items.push({
      id: p.id,
      step: makeSingle(p.kind === 'match' ? 'choice' : p.kind, p.word, moduleWords(p.mod)),
      modTitle: p.mod.title,
    })
  }
  return items
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
  const cycle = voice ? ['choice', 'listen', 'type'] : ['choice', 'type']
  rest.forEach((c, i) => {
    items.push({
      step: makeSingle(cycle[i % cycle.length], c.word, moduleWords(c.mod)),
      weight: 1,
      modTitle: c.mod.title,
    })
  })
  return shuffle(items)
}
