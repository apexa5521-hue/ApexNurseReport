/* Browser stand-ins for the Google Apps Script services used by backend/Code.gs.
   They keep the "spreadsheet" in memory so the real backend code can run inside a static page. */
function createGasServices() {
  function sha256(bytes) {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
    const frac = x => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
    const K = primes.map(p => frac(Math.pow(p, 1 / 3)));
    let H = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
    const len = bytes.length, total = (((len + 9 + 63) >> 6) << 6);
    const buf = new Uint8Array(total);
    buf.set(bytes); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len * 8 / 4294967296)); dv.setUint32(total - 4, (len * 8) >>> 0);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [a, b, c, d, e, f, g, h].map((v, i) => (H[i] + v) >>> 0);
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    H.forEach((v, i) => odv.setUint32(i * 4, v));
    return out;
  }

  function mkSheet(name) {
    const s = {
      name, data: [], maxRows: 1000,
      getLastRow() { let n = s.data.length; while (n > 0 && !s.data[n - 1].some(v => v !== '' && v != null)) n--; return n; },
      getMaxRows() { return Math.max(s.maxRows, s.data.length); },
      insertRowsAfter(a, n) { s.maxRows += n; },
      setFrozenRows() {},
      getDataRange() { return s.getRange(1, 1, Math.max(s.getLastRow(), 1), Math.max(1, ...s.data.map(x => x.length))); },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        const rg = {
          setValues(v) { while (s.data.length < r + nr - 1) s.data.push([]); for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) s.data[r - 1 + i][c - 1 + j] = v[i][j]; return rg; },
          setValue(v) { return rg.setValues([[v]]); },
          getValue() { const row = s.data[r - 1] || []; const v = row[c - 1]; return v == null ? '' : v; },
          getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = s.data[r - 1 + i] || []; const x = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; x.push(v == null ? '' : v); } o.push(x); } return o; },
          clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.data[r - 1 + i]) s.data[r - 1 + i][c - 1 + j] = ''; return rg; },
          setNumberFormat() { return rg; }, setFontWeight() { return rg; }, setBackground() { return rg; }, setFontColor() { return rg; },
        };
        return rg;
      },
    };
    return s;
  }
  const sheets = [];
  const ss = {
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = mkSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets, toast() {},
  };
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const cache = new Map();
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  return {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss, openById() { throw new Error('not available in demo'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.has(k) ? cache.get(k) : null, put: (k, v) => { cache.set(k, v); }, remove: k => { cache.delete(k); } }) },
    MailApp: { sendEmail() {}, getRemainingDailyQuota: () => 100 },
    ScriptApp: { WeekDay: {}, getProjectTriggers: () => [], deleteTrigger() {}, newTrigger() { throw new Error('not available in demo'); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ getContent: () => t, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: uuid, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => sha256(new TextEncoder().encode(str)),
      base64Encode: bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes))),
      // يستخدم توقيت المتصفح بدل الرياض حتى تبقى كل التواريخ متسقة مع بعضها في العرض التجريبي
      formatDate: (d, tz, p) => p.replace(/yyyy|yy|MM|M|dd|d|HH|mm|ss/g, t => ({
        yyyy: d.getFullYear(), yy: pad(d.getFullYear() % 100), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
        dd: pad(d.getDate()), d: d.getDate(), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) })[t]),
    },
    console,
  };
}
