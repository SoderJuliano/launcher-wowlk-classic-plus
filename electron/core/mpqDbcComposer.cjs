'use strict'
/**
 * mpqDbcComposer — pure Node.js MPQ v1 reader/writer + WDBC localized string transplanter.
 *
 * Allows a SINGLE global language pack (e.g. ptBR) to compose seamlessly on top of ANY installed
 * client (standard global wow32 OR Supporter overlay, past or future versions) without duplicating
 * channels or touching Data/patch-Z.MPQ:
 *   1. Reads DBFilesClient\Spell.dbc from the currently active Data/patch-Z.MPQ (or fallback Data/patch-4.MPQ).
 *   2. Replaces ONLY the localized string columns (locstring slots 0..15) using spell-strings-<lang>.json.gz,
 *      preserving 100% of non-string fields (SpellVisualID, cooldowns, flags, custom spells) byte-for-byte.
 *   3. Packages the resulting Spell.dbc into a tiny standalone MPQ v1 archive at Data/patch-~.MPQ
 *      (confirmed in Wow.exe 0x405ab0/0x41b9e0: '~' (0x7E) > 'z' (0x7A), so patch-~.MPQ wins over patch-Z.MPQ).
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const MPQ_MAGIC = 0x1a51504d // 'MPQ\x1a'
const MPQ_FILE_IMPLODE = 0x00000100
const MPQ_FILE_COMPRESS = 0x00000200
const MPQ_FILE_ENCRYPTED = 0x00010000
const MPQ_FILE_FIX_KEY = 0x00020000
const MPQ_FILE_SINGLE_UNIT = 0x01000000
const MPQ_FILE_SECTOR_CRC = 0x04000000
const MPQ_FILE_EXISTS = 0x80000000

const HASH_TABLE_OFFSET = 0
const HASH_NAME_A = 1
const HASH_NAME_B = 2
const HASH_FILE_KEY = 3

const CRYPT_TABLE = (() => {
  const tbl = new Uint32Array(0x500)
  let seed = 0x00100001
  for (let i1 = 0; i1 < 0x100; i1++) {
    for (let i2 = i1, i = 0; i < 5; i++, i2 += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab
      const t1 = (seed & 0xffff) << 16
      seed = (seed * 125 + 3) % 0x2aaaab
      const t2 = seed & 0xffff
      tbl[i2] = (t1 | t2) >>> 0
    }
  }
  return tbl
})()

function hashString(str, hashType) {
  let seed1 = 0x7fed7fed
  let seed2 = 0xeeeeeeee
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i)
    if (ch === 47) ch = 92 // '/' -> '\'
    if (ch >= 97 && ch <= 122) ch -= 32 // ASCII uppercase
    seed1 = (CRYPT_TABLE[(hashType << 8) + ch] ^ ((seed1 + seed2) >>> 0)) >>> 0
    seed2 = (ch + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0
  }
  return seed1 >>> 0
}

function decryptBuffer(buf, key) {
  let k = key >>> 0
  let seed = 0xeeeeeeee
  const count = buf.length >>> 2
  for (let i = 0; i < count; i++) {
    seed = (seed + CRYPT_TABLE[0x400 + (k & 0xff)]) >>> 0
    const raw = buf.readUInt32LE(i * 4)
    const ch = (raw ^ ((k + seed) >>> 0)) >>> 0
    k = (((((~k) << 21) + 0x11111111) >>> 0) | (k >>> 11)) >>> 0
    seed = (ch + seed + ((seed << 5) >>> 0) + 3) >>> 0
    buf.writeUInt32LE(ch, i * 4)
  }
  return buf
}

function encryptBuffer(buf, key) {
  let k = key >>> 0
  let seed = 0xeeeeeeee
  const count = buf.length >>> 2
  for (let i = 0; i < count; i++) {
    seed = (seed + CRYPT_TABLE[0x400 + (k & 0xff)]) >>> 0
    const ch = buf.readUInt32LE(i * 4)
    const enc = (ch ^ ((k + seed) >>> 0)) >>> 0
    k = (((((~k) << 21) + 0x11111111) >>> 0) | (k >>> 11)) >>> 0
    seed = (ch + seed + ((seed << 5) >>> 0) + 3) >>> 0
    buf.writeUInt32LE(enc, i * 4)
  }
  return buf
}

function readRange(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length)
  let done = 0
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done)
    if (n <= 0) throw new Error(`Unexpected EOF reading MPQ at ${offset + done}`)
    done += n
  }
  return buf
}

function decompressSector(raw, expectedSize, flags) {
  if (raw.length === expectedSize) return raw
  if (flags & MPQ_FILE_COMPRESS) {
    const mask = raw[0]
    const payload = raw.subarray(1)
    if (mask === 0x02) {
      return zlib.inflateSync(payload)
    }
    throw new Error(`Unsupported MPQ compression mask 0x${mask.toString(16)}`)
  }
  if (flags & MPQ_FILE_IMPLODE) {
    throw new Error('Unsupported MPQ PKWARE implode compression')
  }
  return raw
}

/**
 * Extracts a single file from an MPQ v1/v2 archive in pure Node.js.
 * Returns Buffer or null if not found.
 */
function extractFileFromMpq(mpqPath, internalName) {
  const fd = fs.openSync(mpqPath, 'r')
  try {
    const hdr = readRange(fd, 0, 32)
    if (hdr.readUInt32LE(0) !== MPQ_MAGIC) throw new Error(`Not a valid MPQ archive: ${mpqPath}`)
    const blockSizeShift = hdr.readUInt16LE(14)
    const hashTableOffset = hdr.readUInt32LE(16)
    const blockTableOffset = hdr.readUInt32LE(20)
    const hashTableEntries = hdr.readUInt32LE(24)
    const blockTableEntries = hdr.readUInt32LE(28)
    const sectorSize = 512 << blockSizeShift

    const hashBuf = decryptBuffer(readRange(fd, hashTableOffset, hashTableEntries * 16), hashString('(hash table)', HASH_FILE_KEY))
    const blockBuf = decryptBuffer(readRange(fd, blockTableOffset, blockTableEntries * 16), hashString('(block table)', HASH_FILE_KEY))

    const hashA = hashString(internalName, HASH_NAME_A)
    const hashB = hashString(internalName, HASH_NAME_B)
    const startIdx = hashString(internalName, HASH_TABLE_OFFSET) & (hashTableEntries - 1)

    let blockIdx = -1
    for (let i = 0; i < hashTableEntries; i++) {
      const idx = (startIdx + i) & (hashTableEntries - 1)
      const off = idx * 16
      const bIdx = hashBuf.readUInt32LE(off + 12)
      if (bIdx === 0xffffffff) break // empty slot
      if (bIdx === 0xfffffffe) continue // deleted slot
      if (hashBuf.readUInt32LE(off) === hashA && hashBuf.readUInt32LE(off + 4) === hashB) {
        blockIdx = bIdx
        break
      }
    }
    if (blockIdx < 0 || blockIdx >= blockTableEntries) return null

    const boff = blockIdx * 16
    const filePos = blockBuf.readUInt32LE(boff)
    const cSize = blockBuf.readUInt32LE(boff + 4)
    const fSize = blockBuf.readUInt32LE(boff + 8)
    const flags = blockBuf.readUInt32LE(boff + 12)

    if ((flags & MPQ_FILE_EXISTS) === 0) return null
    if (fSize === 0) return Buffer.alloc(0)

    const encrypted = (flags & MPQ_FILE_ENCRYPTED) !== 0
    let fileKey = 0
    if (encrypted) {
      const baseName = internalName.split(/[\\/]/).pop()
      fileKey = hashString(baseName, HASH_FILE_KEY)
      if (flags & MPQ_FILE_FIX_KEY) {
        fileKey = (((fileKey + filePos) >>> 0) ^ fSize) >>> 0
      }
    }

    const compressed = (flags & (MPQ_FILE_COMPRESS | MPQ_FILE_IMPLODE)) !== 0

    if ((flags & MPQ_FILE_SINGLE_UNIT) || !compressed) {
      const data = readRange(fd, filePos, compressed ? cSize : fSize)
      if (encrypted) decryptBuffer(data, fileKey)
      return compressed ? decompressSector(data, fSize, flags) : data
    }

    const sectorCount = Math.ceil(fSize / sectorSize)
    const hasCrc = (flags & MPQ_FILE_SECTOR_CRC) !== 0
    const offsetCount = sectorCount + 1 + (hasCrc ? 1 : 0)
    const offsetBuf = readRange(fd, filePos, offsetCount * 4)
    if (encrypted) decryptBuffer(offsetBuf, (fileKey - 1) >>> 0)

    const out = Buffer.allocUnsafe(fSize)
    let outPos = 0
    for (let s = 0; s < sectorCount; s++) {
      const sStart = offsetBuf.readUInt32LE(s * 4)
      const sEnd = offsetBuf.readUInt32LE((s + 1) * 4)
      const expected = Math.min(sectorSize, fSize - outPos)
      const raw = readRange(fd, filePos + sStart, sEnd - sStart)
      if (encrypted) decryptBuffer(raw, (fileKey + s) >>> 0)
      const dec = decompressSector(raw, expected, flags)
      if (dec.length !== expected) {
        throw new Error(`MPQ sector ${s} size mismatch: got ${dec.length}, expected ${expected}`)
      }
      dec.copy(out, outPos)
      outPos += expected
    }
    return out
  } finally {
    fs.closeSync(fd)
  }
}

function packMpqFile(fileBuffer, sectorSize = 4096) {
  const fSize = fileBuffer.length
  const sectorCount = Math.ceil(fSize / sectorSize)
  const sectors = []
  const offsets = new Uint32Array(sectorCount + 1)
  let relOffset = (sectorCount + 1) * 4

  for (let s = 0; s < sectorCount; s++) {
    offsets[s] = relOffset
    const chunk = fileBuffer.subarray(s * sectorSize, Math.min((s + 1) * sectorSize, fSize))
    const deflated = zlib.deflateSync(chunk, { level: 6 })
    if (deflated.length + 1 < chunk.length) {
      const packed = Buffer.allocUnsafe(deflated.length + 1)
      packed[0] = 0x02 // zlib
      deflated.copy(packed, 1)
      sectors.push(packed)
      relOffset += packed.length
    } else {
      sectors.push(Buffer.from(chunk))
      relOffset += chunk.length
    }
  }
  offsets[sectorCount] = relOffset

  const offsetBuf = Buffer.allocUnsafe(offsets.length * 4)
  for (let i = 0; i < offsets.length; i++) offsetBuf.writeUInt32LE(offsets[i], i * 4)

  return {
    packed: Buffer.concat([offsetBuf, ...sectors]),
    fSize,
    flags: (MPQ_FILE_EXISTS | MPQ_FILE_COMPRESS) >>> 0
  }
}

/**
 * Creates a standard MPQ v1 archive containing the given entries [{ name, data }].
 * Automatically includes (listfile). Written atomically via .tmp rename.
 */
function createMpqArchive(outputPath, entries) {
  const sectorSize = 4096
  const blockSizeShift = 3 // 512 << 3 = 4096
  const listfileText = entries.map((e) => e.name.replace(/\//g, '\\')).join('\r\n') + '\r\n'
  const allEntries = [
    ...entries.map((e) => ({ name: e.name.replace(/\//g, '\\'), data: e.data })),
    { name: '(listfile)', data: Buffer.from(listfileText, 'latin1') }
  ]

  // Hash table size: power of 2 >= 2 * entries (minimum 16)
  let hashCount = 16
  while (hashCount < allEntries.length * 2) hashCount <<= 1

  const headerSize = 32
  let cursor = headerSize
  const fileChunks = []
  const blockMeta = []

  for (const e of allEntries) {
    const packed = packMpqFile(e.data, sectorSize)
    blockMeta.push({
      name: e.name,
      filePos: cursor,
      cSize: packed.packed.length,
      fSize: packed.fSize,
      flags: packed.flags
    })
    fileChunks.push(packed.packed)
    cursor += packed.packed.length
  }

  const hashTableOffset = cursor
  const hashBuf = Buffer.alloc(hashCount * 16, 0xff)
  for (let bIdx = 0; bIdx < blockMeta.length; bIdx++) {
    const name = blockMeta[bIdx].name
    const hashA = hashString(name, HASH_NAME_A)
    const hashB = hashString(name, HASH_NAME_B)
    const startIdx = hashString(name, HASH_TABLE_OFFSET) & (hashCount - 1)
    let placed = false
    for (let i = 0; i < hashCount; i++) {
      const idx = (startIdx + i) & (hashCount - 1)
      const off = idx * 16
      if (hashBuf.readUInt32LE(off + 12) === 0xffffffff) {
        hashBuf.writeUInt32LE(hashA, off)
        hashBuf.writeUInt32LE(hashB, off + 4)
        hashBuf.writeUInt16LE(0, off + 8) // locale neutral (enUS/default)
        hashBuf.writeUInt16LE(0, off + 10) // platform
        hashBuf.writeUInt32LE(bIdx, off + 12)
        placed = true
        break
      }
    }
    if (!placed) throw new Error('MPQ hash table full')
  }
  encryptBuffer(hashBuf, hashString('(hash table)', HASH_FILE_KEY))
  cursor += hashBuf.length

  const blockTableOffset = cursor
  const blockBuf = Buffer.alloc(blockMeta.length * 16)
  for (let i = 0; i < blockMeta.length; i++) {
    const bm = blockMeta[i]
    const off = i * 16
    blockBuf.writeUInt32LE(bm.filePos, off)
    blockBuf.writeUInt32LE(bm.cSize, off + 4)
    blockBuf.writeUInt32LE(bm.fSize, off + 8)
    blockBuf.writeUInt32LE(bm.flags, off + 12)
  }
  encryptBuffer(blockBuf, hashString('(block table)', HASH_FILE_KEY))
  cursor += blockBuf.length

  const archiveSize = cursor
  const header = Buffer.alloc(headerSize)
  header.writeUInt32LE(MPQ_MAGIC, 0)
  header.writeUInt32LE(headerSize, 4)
  header.writeUInt32LE(archiveSize, 8)
  header.writeUInt16LE(0, 12) // formatVersion = 0 (MPQ v1)
  header.writeUInt16LE(blockSizeShift, 14)
  header.writeUInt32LE(hashTableOffset, 16)
  header.writeUInt32LE(blockTableOffset, 20)
  header.writeUInt32LE(hashCount, 24)
  header.writeUInt32LE(blockMeta.length, 28)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const tmp = `${outputPath}.olk-tmp`
  const out = Buffer.concat([header, ...fileChunks, hashBuf, blockBuf])
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, outputPath)
  return archiveSize
}

/**
 * Transplants ONLY localized string slots (0..15) of the specified locstring fields into a WDBC buffer.
 * Preserves 100% of non-string fields (SpellVisualID, flags, cooldowns, custom spells, etc.) byte-for-byte.
 */
function applySpellStringsToDbc(dbcBuf, spellPatchObj) {
  if (dbcBuf.length < 20 || dbcBuf.toString('ascii', 0, 4) !== 'WDBC') {
    throw new Error('Invalid WDBC header in Spell.dbc')
  }
  const recordCount = dbcBuf.readUInt32LE(4)
  const fieldCount = dbcBuf.readUInt32LE(8)
  const recordSize = dbcBuf.readUInt32LE(12)
  const stringBlockSize = dbcBuf.readUInt32LE(16)
  if (recordSize !== fieldCount * 4) {
    throw new Error(`Unexpected Spell.dbc recordSize ${recordSize} != ${fieldCount * 4}`)
  }

  const locFields = Array.isArray(spellPatchObj.locstring_fields)
    ? spellPatchObj.locstring_fields
    : [136, 153, 170, 187]
  const spells = spellPatchObj.spells || {}

  const rowsOffset = 20
  const rowsSize = recordCount * recordSize
  const origStrings = dbcBuf.subarray(rowsOffset + rowsSize, rowsOffset + rowsSize + stringBlockSize)
  const rowsOut = Buffer.from(dbcBuf.subarray(rowsOffset, rowsOffset + rowsSize))

  // Preserve original string block intact and append deduplicated translated strings at the end.
  // That way any non-translated spell or string column keeps its exact original offset with zero churn!
  const appendedChunks = [Buffer.from(origStrings)]
  let strCursor = origStrings.length
  if (strCursor === 0) {
    appendedChunks.push(Buffer.from([0]))
    strCursor = 1
  }
  const strCache = new Map()
  const addString = (s) => {
    if (!s) return 0
    const hit = strCache.get(s)
    if (hit !== undefined) return hit
    const buf = Buffer.from(`${s}\0`, 'utf8')
    const off = strCursor
    appendedChunks.push(buf)
    strCursor += buf.length
    strCache.set(s, off)
    return off
  }

  let translatedRows = 0
  for (let r = 0; r < recordCount; r++) {
    const rowBase = r * recordSize
    const sid = rowsOut.readUInt32LE(rowBase)
    const entry = spells[String(sid)]
    if (!entry) continue
    let changed = false
    for (let li = 0; li < locFields.length && li < entry.length; li++) {
      const txt = entry[li]
      if (!txt) continue
      const newOff = addString(txt)
      const fieldStart = locFields[li]
      // Write all 16 locale slots (0..15), leaving slot 16 (locFlags) 100% untouched.
      for (let slot = 0; slot < 16; slot++) {
        rowsOut.writeUInt32LE(newOff, rowBase + (fieldStart + slot) * 4)
      }
      changed = true
    }
    if (changed) translatedRows++
  }

  const newStrings = Buffer.concat(appendedChunks)
  const header = Buffer.allocUnsafe(20)
  header.write('WDBC', 0, 'ascii')
  header.writeUInt32LE(recordCount, 4)
  header.writeUInt32LE(fieldCount, 8)
  header.writeUInt32LE(recordSize, 12)
  header.writeUInt32LE(newStrings.length, 16)

  return {
    dbc: Buffer.concat([header, rowsOut, newStrings]),
    recordCount,
    translatedRows
  }
}

/**
 * End-to-end helper: extracts Spell.dbc from sourceMpqPath, applies gzipped spell strings,
 * and writes a standalone high-priority MPQ (e.g. Data/patch-~.MPQ).
 */
function composeSpellLanguageMpq({ sourceMpqPath, spellPatchGzPath, outputMpqPath }) {
  const spellDbc = extractFileFromMpq(sourceMpqPath, 'DBFilesClient\\Spell.dbc')
  if (!spellDbc) {
    throw new Error(`DBFilesClient\\Spell.dbc not found inside ${sourceMpqPath}`)
  }
  const patchObj = JSON.parse(zlib.gunzipSync(fs.readFileSync(spellPatchGzPath)).toString('utf8'))
  const { dbc, recordCount, translatedRows } = applySpellStringsToDbc(spellDbc, patchObj)
  const archiveSize = createMpqArchive(outputMpqPath, [
    { name: 'DBFilesClient\\Spell.dbc', data: dbc }
  ])
  return { archiveSize, recordCount, translatedRows }
}

module.exports = {
  extractFileFromMpq,
  createMpqArchive,
  applySpellStringsToDbc,
  composeSpellLanguageMpq,
  hashString
}
