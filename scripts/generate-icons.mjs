// Genera los íconos de la PWA (192 y 512 px) sin dependencias: dibuja las letras «CS»
// con geometría simple y escribe PNG a mano (zlib + CRC32 de Node).
// Uso: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [15, 17, 23] // fondo oscuro, como el tema de la app
const PANEL = [24, 27, 36]
const ACCENT = [79, 140, 255] // azul de acento
const INK = [230, 232, 238] // color de la letra C

const DEG = Math.PI / 180
const mod360 = (a) => ((a % 360) + 360) % 360
// ¿El ángulo (grados) está dentro del arco que va de `from` a `to` en sentido creciente?
const inArc = (a, from, to) => {
  const span = mod360(to - from)
  return mod360(a - from) <= span
}

// Cobertura (0..1) de un pixel (x, y) en el lienzo de tamaño `s`, por supermuestreo 3x3.
function pixel(x, y, s) {
  const u = s / 512 // todo se define sobre un lienzo de 512 y se escala
  const cx = 256 * u
  const cy = 256 * u
  // Panel redondeado dentro de la zona segura del ícono «maskable» (80 % central)
  const half = 170 * u
  const rad = 56 * u
  const border = 8 * u
  const inRoundRect = (px, py, h, r) => {
    const dx = Math.abs(px - cx) - (h - r)
    const dy = Math.abs(py - cy) - (h - r)
    const ox = Math.max(dx, 0)
    const oy = Math.max(dy, 0)
    return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) <= r
  }

  // Letra C: anillo abierto a la derecha
  const cR = 78 * u // radio medio
  const stroke = 30 * u
  const cCx = cx - 62 * u
  const inC = (px, py) => {
    const d = Math.hypot(px - cCx, py - cy)
    if (Math.abs(d - cR) > stroke / 2) return false
    const a = Math.atan2(py - cy, px - cCx) / DEG
    return !inArc(a, -42, 42)
  }

  // Letra S: dos arcos apilados
  const sR = 40 * u
  const sCx = cx + 74 * u
  const upper = { x: sCx, y: cy - sR }
  const lower = { x: sCx, y: cy + sR }
  const inS = (px, py) => {
    let d = Math.hypot(px - upper.x, py - upper.y)
    if (Math.abs(d - sR) <= stroke / 2) {
      const a = Math.atan2(py - upper.y, px - upper.x) / DEG
      if (inArc(a, -270, -30)) return true // arco superior: de -270° a -30°
    }
    d = Math.hypot(px - lower.x, py - lower.y)
    if (Math.abs(d - sR) <= stroke / 2) {
      const a = Math.atan2(py - lower.y, px - lower.x) / DEG
      if (inArc(a, -90, 210)) return true // arco inferior: de -90° a 210°
    }
    return false
  }

  let r = 0
  let g = 0
  let b = 0
  const N = 3
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const px = x + (i + 0.5) / N
      const py = y + (j + 0.5) / N
      let c = BG
      if (inRoundRect(px, py, half, rad)) {
        c = inRoundRect(px, py, half - border, rad - border) ? PANEL : ACCENT
        if (inRoundRect(px, py, half - border, rad - border)) {
          if (inC(px, py)) c = INK
          else if (inS(px, py)) c = ACCENT
        }
      }
      r += c[0]
      g += c[1]
      b += c[2]
    }
  }
  const n = N * N
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

// --- Escritura de PNG (RGB, 8 bits) ---
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filtro: ninguno
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const [file, size] of [
  ['pwa-192x192.png', 192],
  ['pwa-512x512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(join(OUT, file), png(size))
  console.log('generado', file)
}
