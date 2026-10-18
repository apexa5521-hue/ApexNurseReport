/**
 * نظام تقرير العيادات للتمريض
 * Backend: Google Apps Script (Web App API)
 *
 * طريقة التركيب مشروحة في README.md
 *   1) أنشئ Google Sheet جديد (خاص، غير مشارك)  ←  Extensions  ←  Apps Script  ←  الصق هذا الملف + appsscript.json
 *   2) شغّل الدالة setup() مرة واحدة: تنشئ أوراق النظام
 *   3) ضع رابط الشيت الأساسي في Settings ← FORM_SOURCE، ثم شغّل importFormResponses()
 *      (يسحب ردود النموذج بدون أي تعديل على الشيت الأساسي، وينشئ حسابات الممرضات منها)
 *   4) Deploy ← New deployment ← Web app ← Execute as: Me ← Who has access: Anyone
 *
 * كل الطلبات تصل عبر doPost بجسم JSON: { action, token, ...payload }
 */

/* ════════════════════════════ CONFIG ════════════════════════════ */

const APP = {
  NAME: 'Nursing',
  VERSION: '2026-10-18',   // يجب أن يطابق CLIENT_VERSION في index.html
  TZ: 'Asia/Riyadh',
  SESSION_SECONDS: 6 * 60 * 60, // أقصى مدة يسمح بها CacheService
  HASH_ROUNDS: 250,
  MAX_LOGIN_FAILS: 5,
  LOCK_MINUTES: 10,
};

const ROLES = {
  nurse: 'ممرضة',
  hr: 'الموارد البشرية',
  quality: 'الجودة',
  supply: 'التموين',
  admin: 'مدير النظام',
};

const BRANCHES = { BURIDAH: 'بريدة', ONIZAH: 'عنيزة' };

const S = {
  USERS: 'Users',
  CLINICS: 'Clinics',
  REPORTS: 'Reports',
  ISSUES: 'Issues',
  SETTINGS: 'Settings',
  LOG: 'Audit_Log',
  TEMP: 'Temp_Passwords',
  LEAVES: 'Leaves',
  NOTICES: 'Notices',
  EXCEPTIONS: 'Exceptions',
};

const HEADERS = {
  Users: ['username', 'name', 'email', 'role', 'branch', 'clinics', 'status', 'start_date',
          'pass_hash', 'salt', 'must_change', 'created_at', 'last_login', 'aliases', 'end_date', 'last_reminder', 'login'],
  Clinics: ['clinic_id', 'name', 'branch', 'type', 'has_fridge', 'status'],
  Reports: ['report_id', 'submitted_at', 'week_start', 'timing', 'username', 'nurse_name', 'branch',
            'clinic_id', 'clinic_name', 'expiry_checked', 'earliest_expiry', 'expiry_item',
            'sterilization_ok', 'fridge', 'fridge_temp', 'employee_card', 'cleanliness',
            'missing_tools', 'tools_json', 'other_issue', 'notes', 'issues_count', 'source'],
  Issues: ['issue_id', 'report_id', 'created_at', 'week_start', 'branch', 'clinic_id', 'clinic_name',
           'username', 'nurse_name', 'category', 'item', 'qty', 'severity', 'description',
           'department', 'status', 'occurrences', 'last_seen', 'assigned_to', 'updated_at',
           'updated_by', 'resolved_at', 'resolution', 'reporters'],
  Settings: ['key', 'value', 'description'],
  Audit_Log: ['at', 'user', 'action', 'details'],
  Temp_Passwords: ['name', 'username', 'role', 'temp_password', 'created_at'],
  Exceptions: ['ex_id', 'username', 'week_start', 'type', 'until', 'reason', 'created_at', 'created_by', 'cancelled'],
  Notices: ['notice_id', 'username', 'nurse_name', 'branch', 'weeks', 'streak', 'compliance', 'issued_at', 'issued_by'],
  Leaves: ['leave_id', 'username', 'from_date', 'to_date', 'cancelled', 'created_at', 'created_by'],
};

const DEFAULT_SETTINGS = [
  ['DEADLINE_WEEKDAY', 6, 'يوم التسليم: 6 = السبت (0 الأحد … 6 السبت)'],
  ['LATE_ALLOWED_DAYS', 1, 'عدد أيام السماح بعد يوم التسليم (1 = الأحد يُحسب متأخر)'],
  ['ALLOW_VERY_LATE', 'no', 'no = نافذة التقديم تُغلق من الاثنين (السبت في الوقت، الأحد متأخر). yes = يُقبل التقديم بعدها ويُسجَّل «خارج النافذة»'],
  ['EARLY_ALLOWED_DAYS', 1, 'التسليم قبل يوم التسليم بهذا العدد يُحسب للأسبوع القادم (مبكر)'],
  ['EXPIRY_ALERT_DAYS', 60, 'تنبيه إذا كان أقرب تاريخ انتهاء خلال هذا العدد من الأيام'],
  ['FRIDGE_MIN', 2, 'أقل حرارة مقبولة للثلاجة'],
  ['FRIDGE_MAX', 8, 'أعلى حرارة مقبولة للثلاجة'],
  ['APP_URL', '', 'رابط صفحة المنصة، يُضاف في رسائل التذكير'],
  ['FORM_SOURCE', '', 'رابط الشيت الأساسي (ردود النموذج) لسحب البيانات منه. اتركه فارغاً إذا كان السكربت داخل نفس الشيت'],
  ['FORM_TAB', 'ردود النموذج 1', 'اسم ورقة ردود Google Form'],
  ['LEGACY_OPEN_WEEKS', 2, 'المشاكل المستوردة من آخر N أسابيع تبقى مفتوحة، والأقدم تُؤرشف'],
];

/** العيادات الافتراضية — مستخرجة من بيانات النموذج القديم */
const DEFAULT_CLINICS = (function () {
  // [clinic_id, name, branch, type, has_fridge, status] — الممرضة تختار من قائمة منسدلة بحسب فرعها.
  // ترتيب القائمة هو ترتيب الصفوف في ورقة Clinics (غيّره من الورقة مباشرة).
  const list = [];
  for (let i = 1; i <= 13; i++) list.push(['BUR-C' + i, 'Dental Clinic ' + i, 'BURIDAH', 'dental', 'yes', 'active']);
  list.push(['BUR-HYDRAFACIAL', 'Derma Hydrafacial', 'BURIDAH', 'derma', 'no', 'active']);
  list.push(['BUR-CLARITY', 'Derma Clarity', 'BURIDAH', 'derma', 'no', 'active']);
  list.push(['BUR-GENTLE', 'Derma Gentle Pro', 'BURIDAH', 'derma', 'no', 'active']);
  list.push(['BUR-DERMA', 'Derma CLINIC', 'BURIDAH', 'derma', 'no', 'active']);
  list.push(['BUR-STERIL', 'Sterilization - Buraydah', 'BURIDAH', 'sterilization', 'no', 'active']);
  for (let i = 1; i <= 10; i++) list.push(['ONZ-C' + i, 'Dental Clinic ' + i, 'ONIZAH', 'dental', 'yes', 'active']);
  list.push(['ONZ-STERIL', 'Sterilization - Unayzah', 'ONIZAH', 'sterilization', 'no', 'active']);
  return list;
})();

/* فئات المشاكل: أي قسم مسؤول عنها */
const CATEGORIES = {
  tools:        { label: 'أدوات ناقصة',            dept: 'supply'  },
  expiry:       { label: 'صلاحية مواد وأدوية',       dept: 'supply'  },
  expiry_check: { label: 'لم يتم فحص الصلاحية',      dept: 'quality' },
  sterilization:{ label: 'التعقيم والأكياس',         dept: 'quality' },
  fridge:       { label: 'الثلاجة',                 dept: 'quality' },
  card:         { label: 'بطاقة الموظف',             dept: 'hr'      },
  cleanliness:  { label: 'النظافة',                  dept: 'quality' },
  other:        { label: 'مشكلة أخرى',               dept: 'quality' },
};

const ISSUE_STATUS = ['open', 'in_progress', 'resolved', 'archived'];

/* ════════════════════════════ ENTRY POINTS ════════════════════════════ */

function doGet(e) {
  return json_({ ok: true, app: APP.NAME, time: nowStr_() });
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[req.action];
    if (!handler) throw err_('إجراء غير معروف: ' + req.action);
    const user = handler.roles ? requireSession_(req.token, handler.roles) : null;
    // صفحات القراءة: نعيد النتيجة المحفوظة إن لم تتغير البيانات منذ آخر حساب
    const key = handler.cache && user ? respKey_(req, user) : null;
    const hit = key && cacheGet_(key);
    if (hit) return ContentService.createTextOutput('{"ok":true,"version":"' + APP.VERSION + '","data":' + hit + '}').setMimeType(ContentService.MimeType.JSON);
    const data = handler.fn(req, user);
    if (key) cachePut_(key, JSON.stringify(data));
    else if (handler.roles && WRITE_SAFE.indexOf(req.action) < 0) bumpDataVersion_();   // أي تعديل يُبطل النتائج المحفوظة
    return json_({ ok: true, data: data, version: APP.VERSION });
  } catch (ex) {
    const msg = ex && ex.userMessage ? ex.userMessage : 'حدث خطأ في الخادم';
    if (!(ex && ex.userMessage)) console.error(req.action, ex && ex.stack || ex);
    return json_({ ok: false, error: msg, code: ex && ex.code || 'ERR' });
  }
}

const STAFF = ['hr', 'quality', 'supply', 'admin'];
const WRITE_SAFE = ['me'];   // طلبات لا تغيّر البيانات ولا تُحفظ

const ACTIONS = {
  login:            { fn: apiLogin_ },
  logout:           { fn: apiLogout_ },
  me:               { roles: ['*'], fn: (r, u) => ({ user: publicUser_(u) }) },
  changePassword:   { roles: ['*'], fn: apiChangePassword_ },

  'nurse.context':  { roles: ['nurse', 'admin'], fn: apiNurseContext_, cache: true },
  'nurse.submit':   { roles: ['nurse', 'admin'], fn: apiNurseSubmit_ },

  'hr.overview':    { roles: ['hr', 'admin'], fn: apiHrOverview_, cache: true },
  'hr.remind':      { roles: ['hr', 'admin'], fn: apiHrRemind_ },
  'hr.notice':      { roles: ['hr', 'admin'], fn: apiHrNotice_ },
  // الموارد البشرية لا ترى الإحصائيات الفنية (تعقيم، أدوية، ثلاجة…) ولا تفاصيل التقارير
  'quality.stats':  { roles: ['quality', 'admin'], fn: apiQualityStats_, cache: true },
  'reports.list':   { roles: ['quality', 'admin'], fn: apiReportsList_, cache: true },

  'issues.list':    { roles: STAFF, fn: apiIssuesList_, cache: true },
  'issues.update':  { roles: ['supply', 'quality', 'hr', 'admin'], fn: apiIssueUpdate_ },

  'users.list':     { roles: ['hr', 'admin'], fn: apiUsersList_, cache: true },
  'users.save':     { roles: ['hr', 'admin'], fn: apiUserSave_ },
  'users.reset':    { roles: ['hr', 'admin'], fn: apiUserReset_ },
  'users.setStatus': { roles: ['hr', 'admin'], fn: apiUserSetStatus_ },
  'exceptions.save':   { roles: ['admin'], fn: apiExceptionSave_ },
  'exceptions.cancel': { roles: ['admin'], fn: apiExceptionCancel_ },
  'clinics.list':   { roles: STAFF, fn: () => ({ clinics: clinics_() }), cache: true },
  'clinics.save':   { roles: ['admin', 'quality'], fn: apiClinicSave_ },
};

/* ════════════════════════════ AUTH ════════════════════════════ */

/** كل الحسابات التي يطابقها ما كُتب في خانة الدخول (بدون اعتبار للمسافات أو حالة الأحرف) */
function loginCandidates_(raw) {
  const id = String(raw || '').trim().toLowerCase(), idc = id.replace(/\s+/g, '');
  if (!id) return [];
  const eq = v => { const x = String(v || '').trim().toLowerCase(); return !!x && (x === id || x.replace(/\s+/g, '') === idc); };
  return rows_(S.USERS).filter(x => x.role !== 'merged' && (eq(x.username) || eq(x.email) || eq(x.login)));
}

/** إن طابق أكثر من حساب (مثل حساب قديم مكرر) نختار الذي تصح معه كلمة المرور */
function pickLoginUser_(cands, pw) {
  return cands.find(x => x.status === 'active' && x.pass_hash && hash_(pw, x.salt) === x.pass_hash)
    || cands.find(x => x.status === 'active' && x.pass_hash) || cands[0] || null;
}

function apiLogin_(req) {
  const id = String(req.username || '').trim().toLowerCase();
  const pw = String(req.password || '').trim();
  if (!id || !pw) throw err_('أدخل اسم المستخدم وكلمة المرور');

  const u = pickLoginUser_(loginCandidates_(id), pw);

  // العدّاد على الحساب نفسه: لا يمكن مضاعفة المحاولات بالتبديل بين الاسم والإيميل
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + (u ? String(u.username).toLowerCase() : id);
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= APP.MAX_LOGIN_FAILS) throw err_('تم إيقاف المحاولة مؤقتاً. حاول بعد ' + APP.LOCK_MINUTES + ' دقائق');

  if (!u || u.status !== 'active' || hash_(pw, u.salt) !== u.pass_hash) {
    cache.put(failKey, String(fails + 1), APP.LOCK_MINUTES * 60);
    throw err_('بيانات الدخول غير صحيحة');
  }
  cache.remove(failKey);

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('s_' + token, u.username, APP.SESSION_SECONDS);
  setCell_(S.USERS, u._row, 'last_login', nowStr_());
  log_(u.username, 'login', '');
  return { token: token, user: publicUser_(u) };
}

/**
 * يفك القفل المؤقت عن حسابات الدخول فوراً (بدل انتظار LOCK_MINUTES). شغّله من المحرر عند الحاجة.
 * clearLoginLocks() يفك الجميع، أو clearLoginLocks('admin') لحساب واحد.
 */
function clearLoginLocks(username) {
  const cache = CacheService.getScriptCache();
  const keys = username ? [String(username)] : rows_(S.USERS).map(u => String(u.username));
  keys.forEach(k => cache.remove('fail_' + k.toLowerCase()));
  SpreadsheetApp.getActive().toast('تم فك القفل عن ' + (username || 'جميع الحسابات'), APP.NAME, 6);
}

/**
 * يضبط كلمة مرور حساب بنفسك ويفك قفله ويفحص الدخول من الداخل. شغّله من المحرر: resetPassword('admin', 'كلمتك').
 * يكتب نتيجة الفحص في Logs (View ← Logs أو Execution log).
 */
function resetPassword(username, newPassword) {
  const id = String(username || '').trim().toLowerCase();
  if (!id || String(newPassword || '').length < 6) throw new Error('resetPassword("admin", "كلمة من 6 خانات على الأقل")');
  const u = rows_(S.USERS).find(x => String(x.username).toLowerCase() === id);
  if (!u) throw new Error('لا يوجد حساب باسم ' + id + '. الموجود: ' + rows_(S.USERS).filter(x => x.role !== 'nurse').map(x => x.username).join(', '));
  setCells_(S.USERS, u._row, Object.assign(passwordFields_(String(newPassword), false, u.login || ''), { status: 'active' }));
  CacheService.getScriptCache().remove('fail_' + id);
  const r = apiLogin_({ username: id, password: String(newPassword) });
  Logger.log('تم. الدخول يعمل الآن بـ ' + id + ' (الدور: ' + r.user.role + ')');
  SpreadsheetApp.getActive().toast('تم ضبط كلمة مرور ' + id + ' ونجح الفحص', APP.NAME, 8);
}

function apiLogout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return {};
}

function apiChangePassword_(req, sessionUser) {
  const user = rows_(S.USERS).find(x => x.username === sessionUser.username);   // الصف الكامل (قد تكون الجلسة محفوظة مختصرة)
  const oldPw = String(req.oldPassword || '');
  const newPw = String(req.newPassword || '').trim();
  if (hash_(oldPw, user.salt) !== user.pass_hash) throw err_('كلمة المرور الحالية غير صحيحة');
  if (newPw.length < 6) throw err_('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
  if (newPw === oldPw) throw err_('اختر كلمة مرور مختلفة عن الحالية');
  const salt = Utilities.getUuid();
  setCells_(S.USERS, user._row, { pass_hash: hash_(newPw, salt), salt: salt, must_change: 'no' });
  log_(user.username, 'change_password', '');
  return { user: publicUser_(Object.assign({}, user, { must_change: 'no' })) };
}

function requireSession_(token, roles) {
  const username = token && CacheService.getScriptCache().get('s_' + token);
  if (!username) throw err_('انتهت الجلسة، سجّل الدخول مرة أخرى', 'AUTH');
  const uk = 'u_' + dataVersion_() + '_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, username));
  const cached = CacheService.getScriptCache().get(uk);
  let u = cached ? JSON.parse(cached) : rows_(S.USERS).find(x => x.username === username);
  if (u && !cached) { const c = {}; ['username', 'name', 'email', 'role', 'branch', 'clinics', 'status', 'must_change', 'login', 'start_date'].forEach(k => c[k] = u[k]); CacheService.getScriptCache().put(uk, JSON.stringify(c), 600); u = Object.assign({}, u); }
  if (!u || u.status !== 'active') throw err_('الحساب غير نشط', 'AUTH');
  if (roles.indexOf('*') < 0 && roles.indexOf(u.role) < 0) throw err_('ليست لديك صلاحية لهذه الصفحة', 'FORBIDDEN');
  if (u.must_change === 'yes' && roles.indexOf('*') < 0) throw err_('يجب تغيير كلمة المرور أولاً', 'MUST_CHANGE');
  return u;
}

function publicUser_(u) {
  return {
    username: u.username, name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role] || u.role,
    branch: u.branch || 'ALL', clinics: splitList_(u.clinics), mustChange: u.must_change === 'yes',
  };
}

function hash_(pw, salt) {
  let h = String(salt) + '|' + pw;
  for (let i = 0; i < APP.HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

/** فلترة حسب فرع المستخدم (ALL = كل الفروع) */
function branchAllowed_(user, branch) {
  return !user.branch || user.branch === 'ALL' || user.branch === branch;
}

/* ════════════════════════════ WEEK LOGIC ════════════════════════════ */

/**
 * أسبوع التقرير يُعرَّف بتاريخ يوم التسليم (السبت افتراضياً).
 * - التسليم يوم السبت ⇐ في الوقت
 * - خلال أيام السماح بعده ⇐ متأخر
 * - بعدها ⇐ خارج النافذة (very_late، يُحسب لنفس الأسبوع)
 * - قبل السبت بـ EARLY_ALLOWED_DAYS ⇐ مبكر ويُحسب للأسبوع القادم
 */
function classifySubmission_(date, cfg) {
  cfg = cfg || settings_();
  const d = startOfDay_(date);
  const dow = d.getDay();
  const back = (dow - cfg.DEADLINE_WEEKDAY + 7) % 7; // أيام منذ آخر يوم تسليم
  const fwd = (7 - back) % 7;                         // أيام حتى يوم التسليم القادم
  if (back !== 0 && fwd > 0 && fwd <= cfg.EARLY_ALLOWED_DAYS) {
    return { week: dateStr_(addDays_(d, fwd)), timing: 'early' };
  }
  const week = dateStr_(addDays_(d, -back));
  const timing = back === 0 ? 'on_time' : back <= cfg.LATE_ALLOWED_DAYS ? 'late' : 'very_late';
  return { week: week, timing: timing };
}

/** أسبوع التسليم الحالي (السبت الحالي أو الماضي) */
function currentWeek_(cfg) {
  return classifySubmission_(new Date(), cfg).week;
}

function weeksBack_(weekStr, n) {
  const out = [];
  const base = parseDate_(weekStr);
  for (let i = n - 1; i >= 0; i--) out.push(dateStr_(addDays_(base, -7 * i)));
  return out;
}

function normalizeWeek_(w, cfg) {
  if (!w) return currentWeek_(cfg);
  const d = parseDate_(w);
  if (!d) throw err_('تاريخ غير صحيح');
  const back = (d.getDay() - cfg.DEADLINE_WEEKDAY + 7) % 7;
  return dateStr_(addDays_(d, -back));
}

const TIMING_RANK = { early: 4, on_time: 3, late: 2, very_late: 1, missing: 0 };

/* ════════════════════════════ NURSE ════════════════════════════ */

function apiNurseContext_(req, user) {
  const cfg = settings_();
  const week = currentWeek_(cfg);
  const now = classifySubmission_(new Date(), cfg);
  const clinics = nurseClinics_(user);
  const reports = rows_(S.REPORTS);
  const mine = reports.filter(r => r.username === user.username);

  const thisWeek = mine.filter(r => r.week_start === now.week);
  const weekAll = reports.filter(r => r.week_start === now.week);
  const history = weeksBack_(week, 12).map(w => {
    const rs = mine.filter(r => r.week_start === w);
    return { week: w, timing: bestTiming_(rs), count: rs.length };
  });
  // إحصائياتها وآخر تقاريرها (تظهر حتى خارج نافذة التقديم)
  const me = buildRoster_({ role: 'admin', branch: 'ALL' }, week, weeksBack_(week, 12), cfg).find(r => r.username === user.username) || {};
  const recent = mine.slice().sort((a, b) => a.submitted_at < b.submitted_at ? 1 : -1).slice(0, 6).map(r => ({
    report_id: r.report_id, submitted_at: r.submitted_at, week_start: r.week_start, timing: r.timing, clinic_name: r.clinic_name,
    issues_count: Number(r.issues_count) || 0, notes: r.notes || '', other_issue: r.other_issue || '' }));
  // متابعة البلاغات: ما بلّغت عنه هي فقط، وليس كل ما في عيادتها
  const openIssues = rows_(S.ISSUES)
    .filter(i => (i.status === 'open' || i.status === 'in_progress') && reportedBy_(i, user.username))
    .map(issueOut_);
  const eff = effectiveWindow_(user.username, new Date(), cfg);
  const closed = eff.closed;
  const nextSat = addDays_(parseDate_(now.week), 7);

  return {
    user: publicUser_(user),
    week: now.week,
    timingIfNow: closed ? 'closed' : eff.timing,
    window: {
      state: closed ? 'closed' : eff.excused ? 'excused' : now.timing,          // early | on_time | late | closed | excused
      excusedUntil: eff.excused ? eff.until : '', exception: eff.exception || null,
      saturday: now.week, sunday: dateStr_(addDays_(parseDate_(now.week), 1)), monday: dateStr_(addDays_(parseDate_(now.week), 2)),
      opensOn: dateStr_(addDays_(nextSat, -cfg.EARLY_ALLOWED_DAYS)), nextDeadline: dateStr_(nextSat),
    },
    deadline: now.week,
    lateUntil: dateStr_(addDays_(parseDate_(now.week), cfg.LATE_ALLOWED_DAYS)),
    clinics: clinics.map(c => ({
      clinic_id: c.clinic_id, name: c.name, branch: c.branch, type: c.type, has_fridge: c.has_fridge === 'yes',
      submitted: weekAll.some(r => r.clinic_id === c.clinic_id),
      submittedByMe: thisWeek.some(r => r.clinic_id === c.clinic_id),
    })),
    stats: { weeks: 12, compliance: me.compliance == null ? null : me.compliance, onTime: me.onTimeRate == null ? null : me.onTimeRate,
             lastSubmission: me.lastSubmission || '', missedStreak: me.missedStreak || 0, openReports: openIssues.length,
             state: me.state || 'active', leave: me.leave || null },
    recent: recent,
    submittedThisWeek: thisWeek.map(reportOut_),
    history: history,
    openIssues: openIssues,
    fridgeRange: [cfg.FRIDGE_MIN, cfg.FRIDGE_MAX],
  };
}

function allowVeryLate_(cfg) { return String(cfg.ALLOW_VERY_LATE).toLowerCase() === 'yes'; }

function nurseClinics_(user) {
  const all = clinics_().filter(c => c.status === 'active');
  const assigned = splitList_(user.clinics);
  if (assigned.length) return all.filter(c => assigned.indexOf(c.clinic_id) >= 0);
  // الافتراضي: كل أقسام فرعها ما عدا التعقيم (وحدة التعقيم تُسند لممرضة التعقيم صراحةً من الموارد البشرية)
  return all.filter(c => c.type !== 'sterilization' && (!user.branch || user.branch === 'ALL' || c.branch === user.branch));
}

function apiNurseSubmit_(req, user) {
  const cfg = settings_();
  const win = effectiveWindow_(user.username, new Date(), cfg);
  if (win.closed) {
    throw err_('نافذة التقديم لهذا الأسبوع مغلقة. التقديم السبت، ويُقبل الأحد كمتأخر. تفتح النافذة القادمة من الجمعة.', 'CLOSED');
  }
  const p = req.report || {};
  const clinic = nurseClinics_(user).find(c => c.clinic_id === p.clinic_id);   // يجب أن تكون من عيادات فرعها/تخصيصها
  if (!clinic) throw err_('اختر العيادة من القائمة');

  const yn = v => (v === 'yes' || v === 'no') ? v : null;
  const r = {
    expiry_checked: yn(p.expiry_checked),
    sterilization_ok: yn(p.sterilization_ok),
    employee_card: yn(p.employee_card),
    missing_tools: yn(p.missing_tools),
    fridge: ['ok', 'problem', 'none'].indexOf(p.fridge) >= 0 ? p.fridge : null,
    cleanliness: Number(p.cleanliness),
    earliest_expiry: p.earliest_expiry ? dateStr_(parseDate_(p.earliest_expiry)) : '',
    expiry_item: clean_(p.expiry_item, 120),
    fridge_temp: p.fridge_temp === '' || p.fridge_temp == null ? '' : Number(p.fridge_temp),
    other_issue: clean_(p.other_issue, 500),
    notes: clean_(p.notes, 500),
  };
  const missingField = ['expiry_checked', 'sterilization_ok', 'employee_card', 'missing_tools', 'fridge']
    .find(k => !r[k]);
  if (missingField) throw err_('أكمل جميع الأسئلة الإلزامية');
  if (!(r.cleanliness >= 1 && r.cleanliness <= 5)) throw err_('اختر تقييم النظافة من 1 إلى 5');
  if (r.expiry_checked === 'yes' && !r.earliest_expiry) throw err_('أدخل أقرب تاريخ انتهاء');
  if (r.fridge_temp !== '' && !isFinite(r.fridge_temp)) throw err_('حرارة الثلاجة غير صحيحة');

  const tools = (Array.isArray(p.tools) ? p.tools : [])
    .map(t => ({ item: clean_(t.item, 120), qty: Math.max(1, Math.min(999, Number(t.qty) || 1)),
                 severity: ['high', 'medium', 'low'].indexOf(t.severity) >= 0 ? t.severity : 'medium',
                 note: clean_(t.note, 200) }))
    .filter(t => t.item);
  if (r.missing_tools === 'yes' && !tools.length) throw err_('أضف الأدوات الناقصة');
  if (r.missing_tools === 'no') tools.length = 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const when = new Date();
    const cls = effectiveWindow_(user.username, when, cfg);
    const dup = rows_(S.REPORTS).find(x => x.week_start === cls.week && x.clinic_id === clinic.clinic_id);
    if (dup) throw err_('تم رفع تقرير ' + clinic.name + ' لهذا الأسبوع مسبقاً');

    const report = Object.assign(r, {
      report_id: 'R' + Utilities.formatDate(when, APP.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10),
      submitted_at: nowStr_(), week_start: cls.week, timing: cls.timing,
      username: user.username, nurse_name: user.name, branch: clinic.branch,
      clinic_id: clinic.clinic_id, clinic_name: clinic.name,
      tools_json: JSON.stringify(tools), issues_count: 0, source: 'app',
    });
    const newIssues = upsertIssues_(buildIssues_(report, tools, cfg), report);
    report.issues_count = newIssues;
    appendObjects_(S.REPORTS, [report]);
    log_(user.username, 'submit', report.report_id + ' ' + clinic.clinic_id);
    return { report: reportOut_(report), issues: newIssues };
  } finally {
    lock.releaseLock();
  }
}

/** تحويل إجابات التقرير إلى مشاكل قابلة للمتابعة */
function buildIssues_(r, tools, cfg) {
  const out = [];
  const add = (category, severity, description, item, qty) =>
    out.push({ category: category, severity: severity, description: description, item: item || '', qty: qty || '' });

  if (r.expiry_checked === 'no') add('expiry_check', 'medium', 'لم يتم فحص صلاحية المواد والأدوية');
  if (r.earliest_expiry) {
    const days = daysBetween_(new Date(), parseDate_(r.earliest_expiry));
    if (days <= cfg.EXPIRY_ALERT_DAYS) {
      const sev = days < 0 ? 'high' : days <= 30 ? 'high' : 'medium';
      const txt = days < 0 ? 'منتهية منذ ' + (-days) + ' يوم' : 'تنتهي خلال ' + days + ' يوم';
      add('expiry', sev, (r.expiry_item || 'مادة') + ' — ' + txt + ' (' + r.earliest_expiry + ')', r.expiry_item || 'مادة قريبة الانتهاء');
    }
  }
  if (r.sterilization_ok === 'no') add('sterilization', 'high', 'مشكلة في سلامة التعقيم أو إغلاق الأكياس');
  if (r.fridge === 'problem') add('fridge', 'high', 'مشكلة في سلامة المواد داخل الثلاجة');
  if (r.fridge === 'ok' && r.fridge_temp !== '' &&
      (r.fridge_temp < cfg.FRIDGE_MIN || r.fridge_temp > cfg.FRIDGE_MAX)) {
    add('fridge', 'high', 'حرارة الثلاجة ' + r.fridge_temp + '° خارج النطاق (' + cfg.FRIDGE_MIN + '–' + cfg.FRIDGE_MAX + ')');
  }
  if (r.employee_card === 'no') add('card', 'low', 'بطاقة الموظف غير موجودة');
  if (r.cleanliness && r.cleanliness <= 2) add('cleanliness', 'medium', 'تقييم النظافة ' + r.cleanliness + ' من 5');
  tools.forEach(t => add('tools', t.severity, t.note || ('نقص: ' + t.item), t.item, t.qty));
  if (r.other_issue) add('other', 'medium', r.other_issue);
  return out;
}

/**
 * يضيف المشاكل الجديدة، وإذا كانت نفس المشكلة مفتوحة لنفس العيادة
 * يزيد عدد التكرار بدل إنشاء سطر جديد (يكشف المشاكل المتكررة).
 */
function upsertIssues_(list, report, opts) {
  if (!list.length) return 0;
  opts = opts || {};
  const sheet = sh_(S.ISSUES);
  const existing = opts.cache || rows_(S.ISSUES);
  const key = i => [i.clinic_id, i.category, normText_(i.item)].join('|');
  const openMap = {};
  existing.forEach(i => { if (i.status === 'open' || i.status === 'in_progress') openMap[key(i)] = i; });

  const fresh = [];
  list.forEach((x, idx) => {
    const obj = {
      issue_id: 'I' + report.report_id + '-' + (idx + 1),
      report_id: report.report_id, created_at: report.submitted_at, week_start: report.week_start,
      branch: report.branch, clinic_id: report.clinic_id, clinic_name: report.clinic_name,
      username: report.username, nurse_name: report.nurse_name,
      category: x.category, item: x.item, qty: x.qty, severity: x.severity, description: x.description,
      department: CATEGORIES[x.category].dept, status: opts.status || 'open', occurrences: 1,
      last_seen: report.week_start, assigned_to: '', updated_at: report.submitted_at, updated_by: '', reporters: report.username || '',
      resolved_at: opts.status === 'archived' ? report.submitted_at : '', resolution: opts.resolution || '',
    };
    const prev = openMap[key(obj)];
    if (prev && obj.status !== 'archived') {
      prev.occurrences = Number(prev.occurrences || 1) + 1;
      prev.last_seen = report.week_start;
      prev.qty = obj.qty || prev.qty;
      prev.description = obj.description;
      if (sevRank_(obj.severity) > sevRank_(prev.severity)) prev.severity = obj.severity;
      const rps = splitList_(prev.reporters || prev.username);
      if (report.username && rps.indexOf(report.username) < 0) rps.push(report.username);   // كل من بلّغت عنها تراها في متابعتها
      prev.reporters = rps.join(',');
      if (prev._row) {
        setCells_(S.ISSUES, prev._row, { occurrences: prev.occurrences, last_seen: prev.last_seen, qty: prev.qty,
          description: prev.description, severity: prev.severity, updated_at: report.submitted_at, reporters: prev.reporters });
      }
    } else {
      fresh.push(obj);
      existing.push(obj);
      if (obj.status === 'open') openMap[key(obj)] = obj;
    }
  });
  if (fresh.length) {
    const startRow = sheet.getLastRow() + 1;
    appendObjects_(S.ISSUES, fresh, sheet);
    fresh.forEach((o, i) => { o._row = startRow + i; }); // يسمح بتحديث عدّاد التكرار لاحقاً داخل نفس الدفعة
  }
  return list.length;
}

/* ════════════════════════════ HR ════════════════════════════ */

/** إجازات الممرضات غير الملغاة، مجمّعة باسم المستخدم */
function leavesMap_() {
  const m = {};
  rows_(S.LEAVES).forEach(l => { if (l.cancelled !== 'yes') (m[l.username] = m[l.username] || []).push(l); });
  return m;
}

function onLeave_(leaves, week) {
  return (leaves || []).some(l => l.from_date <= week && week <= l.to_date);
}

/** هل يُطلب من الممرضة تقرير في أسبوع التسليم w (تاريخ السبت)؟ */
function expectedOn_(n, w, leaves, cfg) {
  if (exemptMap_()[n.username + '|' + w]) return false;   // إعفاء من هذا الأسبوع (استثناء من المدير)
  if (n.start_date) { const st = dateStr_(parseDate_(n.start_date)); if (st && w < weekOf_(st, cfg)) return false; }
  if (n.status !== 'active') {
    // متوقفة عن العمل: مطلوبة حتى تاريخ التوقف، وإن لم يُكتب فحتى آخر أسبوع سلّمت فيه (حتى لا يضيع سجلها القديم)
    const end = n.end_date ? dateStr_(parseDate_(n.end_date)) : (lastWeekMap_()[n.username] || '');
    if (!end || w > end) return false;
  }
  return !onLeave_(leaves, w);
}

/* ───────── استثناءات المدير: تمديد المهلة أو إعفاء من أسبوع واحد ───────── */

let EX_ = { src: null, list: null, exempt: null };
function exceptions_() {
  const src = rows_(S.EXCEPTIONS);
  if (EX_.src !== src) {
    const list = src.filter(x => x.cancelled !== 'yes');
    const exempt = {};
    list.forEach(x => { if (x.type === 'exempt') exempt[x.username + '|' + x.week_start] = x; });
    EX_ = { src: src, list: list, exempt: exempt };
  }
  return EX_;
}
function exemptMap_() { return exceptions_().exempt; }
/** آخر استثناء فعّال لممرضة في أسبوع */
function exceptionFor_(username, week) {
  const l = exceptions_().list.filter(x => x.username === username && x.week_start === week);
  return l.length ? l[l.length - 1] : null;
}

/**
 * نافذة التقديم الفعلية لممرضة الآن: القواعد العامة، إلا إذا منحها المدير مهلة لهذا الأسبوع.
 * مع المهلة: ما يُرفع حتى نهاية تاريخ until يُحسب «في الوقت» حتى لو كانت النافذة مغلقة.
 */
function effectiveWindow_(username, when, cfg) {
  const c = classifySubmission_(when, cfg);
  const base = { week: c.week, timing: c.timing, closed: c.timing === 'very_late' && !allowVeryLate_(cfg), excused: false };
  const ex = exceptionFor_(username, c.week);
  if (!ex) return base;
  const today = dateStr_(when);
  if (ex.type === 'extend' && ex.until && today <= ex.until && (c.timing === 'late' || c.timing === 'very_late')) {
    return { week: c.week, timing: 'on_time', closed: false, excused: true, until: ex.until, exception: { type: ex.type, until: ex.until, reason: ex.reason } };
  }
  return Object.assign(base, { exception: { type: ex.type, until: ex.until, reason: ex.reason } });
}

function apiExceptionSave_(req, user) {
  const cfg = settings_();
  const u = rows_(S.USERS).find(x => x.username === req.username && x.role === 'nurse');
  if (!u) throw err_('الممرضة غير موجودة');
  const week = normalizeWeek_(req.week, cfg);
  const type = req.type === 'exempt' ? 'exempt' : 'extend';
  let until = '';
  if (type === 'extend') {
    const d = parseDate_(req.until);
    if (!d) throw err_('حدد آخر يوم للمهلة');
    until = dateStr_(d);
    const last = dateStr_(addDays_(parseDate_(week), 5));   // حتى الخميس، قبل أن تفتح نافذة الأسبوع التالي
    if (until < week) throw err_('تاريخ المهلة قبل سبت هذا الأسبوع');
    if (until > last) throw err_('أقصى مهلة لهذا الأسبوع حتى الخميس ' + last + '. بعدها يبدأ الأسبوع التالي');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // استثناء واحد فعّال لكل ممرضة في الأسبوع: الجديد يحل محل القديم
    rows_(S.EXCEPTIONS).filter(x => x.username === u.username && x.week_start === week && x.cancelled !== 'yes')
      .forEach(x => setCell_(S.EXCEPTIONS, x._row, 'cancelled', 'yes'));
    const ex = { ex_id: 'X' + Utilities.formatDate(new Date(), APP.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10),
      username: u.username, week_start: week, type: type, until: until, reason: clean_(req.reason, 200),
      created_at: nowStr_(), created_by: user.name, cancelled: '' };
    appendObjects_(S.EXCEPTIONS, [ex]);
    // ما رفعته متأخراً قبل الاستثناء يُصحَّح إلى «في الوقت» إن كان ضمن المهلة
    let fixed = 0;
    rows_(S.REPORTS).filter(r => r.username === u.username && r.week_start === week && (r.timing === 'late' || r.timing === 'very_late'))
      .forEach(r => {
        if (type === 'exempt' || String(r.submitted_at).slice(0, 10) <= until) { setCell_(S.REPORTS, r._row, 'timing', 'on_time'); fixed++; }
      });
    log_(user.username, 'exception_' + type, u.username + ' ' + week + (until ? ' → ' + until : '') + (fixed ? ' (صُحّح ' + fixed + ')' : '') + (ex.reason ? ' · ' + ex.reason : ''));
    return { exception: ex, fixed: fixed };
  } finally {
    lock.releaseLock();
  }
}

function apiExceptionCancel_(req, user) {
  const ex = rows_(S.EXCEPTIONS).find(x => x.ex_id === req.id && x.cancelled !== 'yes');
  if (!ex) throw err_('الاستثناء غير موجود');
  setCell_(S.EXCEPTIONS, ex._row, 'cancelled', 'yes');
  log_(user.username, 'exception_cancel', ex.username + ' ' + ex.week_start);
  return { ok: true };
}

/** آخر أسبوع سلّمت فيه كل ممرضة */
let LW_ = { src: null, map: null };
function lastWeekMap_() {
  const src = rows_(S.REPORTS);
  if (LW_.src === src) return LW_.map;   // يُحسب مرة واحدة لكل قراءة للتقارير
  const m = {};
  src.forEach(r => { if (r.week_start > (m[r.username] || '')) m[r.username] = r.week_start; });
  LW_ = { src: src, map: m };
  return m;
}

/** أول أسبوع فيه تقرير ضمن نطاق المستخدم (بداية «كل المدة») */
function firstWeek_(user, fallback) {
  let f = '';
  rows_(S.REPORTS).forEach(r => { if (r.week_start && branchAllowed_(user, r.branch) && (!f || r.week_start < f)) f = r.week_start; });
  return f && f < fallback ? f : fallback;
}

/** أسابيع السبت من from إلى to */
function weeksBetween_(from, to) {
  const out = [];
  for (let d = parseDate_(from); dateStr_(d) <= to; d = addDays_(d, 7)) out.push(dateStr_(d));
  return out;
}

/** الحالة الحالية: على رأس العمل / إجازة (حالية أو قادمة) / متوقفة */
function nurseState_(u, userLeaves, today) {
  const up = (userLeaves || []).filter(l => l.to_date >= today).sort((a, b) => a.from_date < b.from_date ? -1 : 1)[0];
  return {
    state: u.status !== 'active' ? 'inactive' : (up ? 'leave' : 'active'),
    leave: up ? { from: up.from_date, to: up.to_date, current: up.from_date <= today } : null,
  };
}

const ROSTER_ORDER = { missing: 0, very_late: 1, late: 2, on_time: 3, early: 3, leave: 4, na: 5 };

function buildRoster_(user, week, weeks, cfg) {
  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse' && branchAllowed_(user, u.branch));
  const reports = rows_(S.REPORTS).filter(r => branchAllowed_(user, r.branch) && weeks.indexOf(r.week_start) >= 0);
  const lm = leavesMap_();
  const today = dateStr_(new Date());
  const byNurse = {};
  reports.forEach(r => { (byNurse[r.username] = byNurse[r.username] || []).push(r); });

  return nurses.map(n => {
    const mine = byNurse[n.username] || [];
    const leaves = lm[n.username] || [];
    const cells = weeks.map(w => {
      const rs = mine.filter(r => r.week_start === w);
      if (expectedOn_(n, w, leaves, cfg) || rs.length) return bestTiming_(rs);
      return onLeave_(leaves, w) ? 'leave' : 'na';
    });
    const counted = cells.filter(c => c !== 'na' && c !== 'leave');
    const done = counted.filter(c => c !== 'missing');
    const onTime = counted.filter(c => c === 'on_time' || c === 'early');
    let streak = 0;
    for (let i = cells.length - 1; i >= 0; i--) { if (cells[i] === 'missing') streak++; else if (cells[i] !== 'na' && cells[i] !== 'leave') break; }
    const st = nurseState_(n, leaves, today);
    return {
      username: n.username, name: n.name, email: n.email, branch: n.branch, status: n.status,
      state: st.state, leave: st.leave,
      thisWeek: cells[cells.length - 1], cells: cells,
      expectedWeeks: counted.length, doneWeeks: done.length, reports: mine.length,
      compliance: counted.length ? Math.round(done.length / counted.length * 100) : null,
      onTimeRate: counted.length ? Math.round(onTime.length / counted.length * 100) : null,
      missedStreak: streak,
      lastSubmission: mine.reduce((m, r) => r.submitted_at > m ? r.submitted_at : m, ''),
      notices: (noticesMap_()[n.username] || []).length, lastNotice: ((noticesMap_()[n.username] || []).slice(-1)[0] || {}).issued_at || '',
      lastReminder: n.last_reminder || '', remindedToday: String(n.last_reminder || '').slice(0, 10) === today,
    };
  });
}

function apiHrOverview_(req, user) {
  const cfg = settings_();
  const week = normalizeWeek_(req.week, cfg);
  const weeks = req.weeks === 'all' ? weeksBetween_(firstWeek_(user, week), week)
    : weeksBack_(week, Math.min(52, Math.max(4, Number(req.weeks) || 12)));
  const roster = buildRoster_(user, week, weeks, cfg);
  roster.forEach(r => { const ex = exceptionFor_(r.username, week); r.exception = ex ? { id: ex.ex_id, type: ex.type, until: ex.until, reason: ex.reason, by: ex.created_by } : null; });
  // أسابيع متتالية بلا تسليم حتى آخر أسبوع انتهت نافذته (شرط إشعار عدم الالتزام)
  const closedIdx = weeks.indexOf(lastClosedWeek_(cfg));
  roster.forEach(r => {
    let k = 0;
    for (let i = closedIdx; i >= 0; i--) { const c = r.cells[i]; if (c === 'missing') k++; else if (c !== 'na' && c !== 'leave') break; }
    r.noticeStreak = r.state === 'inactive' ? 0 : k;
  });

  const expected = roster.filter(r => r.thisWeek !== 'na' && r.thisWeek !== 'leave');
  const count = t => expected.filter(r => r.thisWeek === t).length;
  const committed = expected.filter(r => r.thisWeek !== 'missing').length;

  // الموارد البشرية ترى فقط ما يخصها: بطاقات الموظفين
  const cardIssues = rows_(S.ISSUES)
    .filter(i => i.category === 'card' && (i.status === 'open' || i.status === 'in_progress') && branchAllowed_(user, i.branch))
    .map(issueOut_);

  const isCurrent = week === currentWeek_(cfg);
  const today = dateStr_(new Date());
  const remindable = isCurrent ? roster.filter(r => r.thisWeek === 'missing' && r.state === 'active' && emailOf_(r)).length : 0;
  return {
    week: week, weeks: weeks, isCurrent: isCurrent,
    summary: {
      expected: expected.length, committed: committed, missing: count('missing'),
      onTime: count('on_time') + count('early'), late: count('late') + count('very_late'),
      rate: expected.length ? Math.round(committed / expected.length * 100) : 0,
      onLeave: roster.filter(r => r.state === 'leave' && r.thisWeek === 'leave').length,
      stopped: roster.filter(r => r.state === 'inactive').length,
    },
    remindable: remindable,
    hasLink: !!settings_().APP_URL, reminderKind: reminderKindNow_(cfg),
    remindedToday: roster.filter(r => r.thisWeek === 'missing' && String(r.lastReminder).slice(0, 10) === today).length,
    roster: roster.sort((a, b) => (ROSTER_ORDER[a.thisWeek] - ROSTER_ORDER[b.thisWeek]) || (a.compliance == null ? 101 : a.compliance) - (b.compliance == null ? 101 : b.compliance)),
    cardIssues: cardIssues,
  };
}

/* ───────── إشعار عدم الالتزام (يُطبع وتوقّعه الممرضة) ───────── */

let NOTICES_CACHE_ = null;
function noticesMap_() {
  if (NOTICES_CACHE_) return NOTICES_CACHE_;
  const m = {};
  rows_(S.NOTICES).forEach(n => (m[n.username] = m[n.username] || []).push(n));
  Object.keys(m).forEach(k => m[k].sort((a, b) => a.issued_at < b.issued_at ? -1 : 1));
  return (NOTICES_CACHE_ = m);
}

/** آخر أسبوع انتهت نافذته (أثناء السبت والأحد يكون أسبوع اليوم ما زال مفتوحاً) */
function lastClosedWeek_(cfg) {
  const cls = classifySubmission_(new Date(), cfg);
  return cls.timing === 'on_time' || cls.timing === 'late' || cls.timing === 'early'
    ? dateStr_(addDays_(parseDate_(cls.week), -7)) : cls.week;
}

/**
 * يسجّل إشعاراً لكل ممرضة لم تسلّم أسبوعين متتاليين أو أكثر (حتى آخر أسبوع مغلق)، ويعيد بيانات الطباعة.
 * req.usernames: قائمة الممرضات، أو فارغة = كل من تنطبق عليها القاعدة
 */
function apiHrNotice_(req, user) {
  const cfg = settings_();
  const week = lastClosedWeek_(cfg);
  const weeks = weeksBack_(week, 52);
  const roster = buildRoster_(user, week, weeks, cfg).filter(r => r.state !== 'inactive');
  const want = (req.usernames || []).map(String);
  const pick = want.length ? roster.filter(r => want.indexOf(r.username) >= 0) : roster.filter(r => r.missedStreak >= 2);
  const out = [], skipped = [];
  const stamp = nowStr_();
  const prior = noticesMap_();
  pick.forEach(r => {
    if (r.missedStreak < 2) { skipped.push(r.name); return; }
    const missed = weeks.slice(weeks.length - r.missedStreak);
    const prev = prior[r.username] || [];
    const id = 'N' + Utilities.formatDate(new Date(), APP.TZ, 'yyMMdd') + '-' + String(rows_(S.NOTICES).length + out.length + 1).padStart(4, '0');
    out.push({ notice_id: id, username: r.username, nurse_name: r.name, branch: r.branch, weeks: missed.join(','),
               streak: r.missedStreak, compliance: r.compliance == null ? '' : r.compliance, issued_at: stamp, issued_by: user.name,
               previous: prev.length, lastPrevious: prev.length ? prev[prev.length - 1].issued_at : '',
               doneWeeks: r.doneWeeks, expectedWeeks: r.expectedWeeks });
  });
  if (out.length) {
    appendObjects_(S.NOTICES, out.map(n => { const o = {}; HEADERS[S.NOTICES].forEach(k => o[k] = n[k]); return o; }));
    NOTICES_CACHE_ = null;
    log_(user.username, 'notice', out.map(n => n.notice_id + ' ' + n.username).join('; '));
  }
  return { notices: out, skipped: skipped, asOf: week };
}

function emailOf_(r) {
  const e = String(r.email || (String(r.username).indexOf('@') > 0 ? r.username : '')).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

/* ───────── تذكير الممرضات اللواتي لم يسلّمن ───────── */

/** نص كل رسالة بحسب موعدها. الرابط لا يُرسل في رسالة الإغلاق (لم يعد التقديم متاحاً). */
const REMINDER_KINDS = {
  open: {
    subject: 'التقديم مفتوح: تقرير العيادة | Clinic report is open',
    ar: w => ['فُتحت نافذة التقديم لتقرير العيادة. موعده السبت ' + w + '.'],
    en: w => ['The clinic report window is now open. The deadline is Saturday ' + w + '.'],
  },
  deadline: {
    subject: 'اليوم موعد تقرير العيادة | Today: clinic report is due',
    ar: w => ['اليوم السبت ' + w + ' هو موعد رفع تقرير العيادة، ولم يصلنا تقريرك بعد.', 'نرجو رفعه اليوم. يُقبل غداً الأحد كتقديم متأخر.'],
    en: w => ['Today, Saturday ' + w + ', is the deadline for the clinic report and we have not received yours yet.', 'Please submit it today. Tomorrow (Sunday) is accepted as late.'],
  },
  late: {
    subject: 'لم تقدّمي تقرير هذا الأسبوع، اليوم آخر يوم | Clinic report not submitted, last day today',
    ar: w => ['لم تقدّمي تقرير العيادة لأسبوع السبت ' + w + '. اليوم الأحد آخر يوم للتقديم، ويُسجَّل متأخراً.', 'بعد اليوم تُغلق نافذة التقديم لهذا الأسبوع.'],
    en: w => ['You have not submitted the clinic report for the week of Saturday ' + w + '. Today (Sunday) is the last day and it will be recorded as late.', 'After today the submission window for this week closes.'],
  },
  closed: {
    subject: 'لم تقدّمي تقرير هذا الأسبوع | You did not submit this week\'s report',
    ar: w => ['لم تقدّمي تقرير العيادة لأسبوع السبت ' + w + '. أُغلقت نافذة التقديم، وسُجّل هذا الأسبوع «لم يُسلَّم».', 'للاستفسار تواصلي مع الموارد البشرية. تفتح النافذة القادمة من يوم الجمعة.'],
    en: w => ['You did not submit the clinic report for the week of Saturday ' + w + '. The submission window is closed and this week is recorded as "not submitted".', 'For questions, please contact HR. The next window opens on Friday.'],
    noLink: true,
  },
};

/** نوع الرسالة المناسب لهذه اللحظة (للزر اليدوي) */
function reminderKindNow_(cfg) {
  const t = classifySubmission_(new Date(), cfg).timing;
  return t === 'early' ? 'open' : t === 'on_time' ? 'deadline' : t === 'late' ? 'late' : 'closed';
}

function apiHrRemind_(req, user) {
  const cfg = settings_();
  const res = sendReminders_(user, currentWeek_(cfg), cfg, reminderKindNow_(cfg));
  log_(user.username, 'remind_' + res.kind, res.sent.length + ' sent');
  return res;
}

/** يرسل بريداً لكل ممرضة نشطة لم تسلّم تقرير الأسبوع (ليست في إجازة ولا متوقفة) */
function sendReminders_(scopeUser, week, cfg, kind) {
  const K = REMINDER_KINDS[kind];
  if (!K) throw err_('نوع تذكير غير معروف');
  const roster = buildRoster_(scopeUser, week, [week], cfg).filter(r => r.thisWeek === 'missing' && r.state === 'active');
  const withMail = roster.filter(emailOf_), noEmail = roster.filter(r => !emailOf_(r)).map(r => r.name);
  const url = cfg.APP_URL ? String(cfg.APP_URL) : '';
  const res = { sent: [], noEmail: noEmail, failed: [], week: week, kind: kind, hasLink: !!url };
  if (!withMail.length) return res;
  const quota = MailApp.getRemainingDailyQuota();
  if (quota < withMail.length) throw err_('حصة البريد اليومية لا تكفي (المتبقي ' + quota + ' رسالة). حاول غداً.');

  const users = {};
  rows_(S.USERS).forEach(u => { users[u.username] = u; });
  withMail.forEach(r => {
    const link = url && !K.noLink;
    const body = ['مرحباً ' + r.name + '،'].concat(K.ar(week),
      link ? ['رابط التقديم: ' + url] : [], ['اسم المستخدم: ' + r.username], ['', 'Hello ' + r.name + ','], K.en(week),
      link ? ['Submission link: ' + url] : [], ['Username: ' + ((users[r.username] || {}).login || r.username)]).join('\n');
    try {
      MailApp.sendEmail({ to: emailOf_(r), subject: K.subject, body: body, name: 'Nursing' });
      res.sent.push(r.name);
      if (users[r.username]) setCell_(S.USERS, users[r.username]._row, 'last_reminder', nowStr_());
    } catch (e) { res.failed.push(r.name); }
  });
  return res;
}

/** المشغّلات التلقائية: السبت (موعد) · الأحد (متأخر) · الاثنين (أُغلقت النافذة) */
function autoReminderSaturday() { const cfg = settings_(); sendReminders_({ role: 'admin', branch: 'ALL' }, currentWeek_(cfg), cfg, 'deadline'); }
function autoReminderSunday() { const cfg = settings_(); sendReminders_({ role: 'admin', branch: 'ALL' }, currentWeek_(cfg), cfg, 'late'); }
function autoReminderMonday() { const cfg = settings_(); sendReminders_({ role: 'admin', branch: 'ALL' }, currentWeek_(cfg), cfg, 'closed'); }

function installReminderTriggers() {
  if (!settings_().APP_URL) throw new Error('ضع رابط المنصة في ورقة Settings ← APP_URL أولاً، ليصل الرابط للممرضات في التذكير');
  const names = ['autoReminderSaturday', 'autoReminderSunday', 'autoReminderMonday'];
  ScriptApp.getProjectTriggers().filter(t => names.indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoReminderSaturday').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(10).create();
  ScriptApp.newTrigger('autoReminderSunday').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(10).create();
  ScriptApp.newTrigger('autoReminderMonday').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  SpreadsheetApp.getActive().toast('تم تفعيل التذكير: السبت 10ص (موعد)، الأحد 10ص (متأخر)، الاثنين 9ص (أُغلقت النافذة)', APP.NAME, 8);
}

/* ───────── أسماء دخول قصيرة وأرقام سرية (اختياري) ───────── */

function editDistance_(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * يطابق اسماً مكتوباً («Emilia») بحساب ممرضة. مطابقة حذرة:
 * الاسم الكامل أو الاسم المستعار أو البريد أو اسم الدخول، أو أول كلمة من اسم الحساب (إن كانت وحيدة).
 * لا يخمّن أكثر من ذلك: عند الشك يرجع الأسباب مع أقرب الحسابات، ويُكتب الحساب الصحيح في عمود account.
 */
function matchNurseByName_(raw, nurses) {
  const q = normText_(raw);
  if (!q) return { err: 'اسم فارغ' };
  const first = u => normText_(String(u.name || '').trim().split(/\s+/)[0]);
  let hits = nurses.filter(u => [u.name].concat(splitList_(u.aliases)).some(k => normText_(k) === q) ||
    normText_(u.email) === q || normText_(u.username) === q || normText_(u.login) === q);
  if (!hits.length) hits = nurses.filter(u => first(u) === q || (q.length >= 4 && normText_(u.name).indexOf(q) === 0));
  if (hits.length > 1) { const act = hits.filter(u => u.status === 'active'); if (act.length && act.length < hits.length) hits = act; }
  if (hits.length === 1) return { user: hits[0] };
  if (hits.length) return { err: 'أكثر من حساب: ' + hits.map(u => u.name + ' (' + (u.email || u.username) + ')').join(' / ') + ' — اكتب بريد الصحيح في عمود account' };
  const near = nurses.filter(u => { const f = first(u); return f && (editDistance_(f, q) <= (q.length <= 5 ? 1 : 2) || (f.slice(0, 4) === q.slice(0, 4) && q.length >= 4)); });
  return { err: 'لا يوجد حساب مطابق' + (near.length ? '. أقرب: ' + near.slice(0, 3).map(u => u.name + ' (' + (u.email || u.username) + ')').join(' / ') + ' — إن كانت هي، اكتب بريدها في عمود account' : '. لإنشاء حساب جديد أضف عمودي email وbranch') };
}

/** اسم دخول قصير غير مكرر: الاسم الأول، وإن تكرر فالاسمان الأول والثاني (sidra.arshad) */
function loginNameFor_(user, taken, wanted) {
  const clean = x => String(x || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const words = String(user.name || '').trim().split(/\s+/).map(clean).filter(Boolean);
  const tries = wanted ? [clean(wanted)] : [words[0], words.slice(0, 2).join('.'), words.join('.')];
  for (let i = 0; i < tries.length; i++) if (tries[i] && tries[i].length >= 3 && !taken[tries[i]]) return tries[i];
  return '';
}

function loginsTaken_(exceptUsername) {
  const t = {};
  rows_(S.USERS).forEach(u => {
    if (u.username === exceptUsername) return;
    [u.username, u.email, u.login].forEach(v => { if (v) t[String(v).toLowerCase()] = 1; });
  });
  return t;
}

function passwordFields_(pw, mustChange, login) {
  const salt = Utilities.getUuid();
  return { pass_hash: hash_(pw, salt), salt: salt, must_change: mustChange ? 'yes' : 'no', login: login };
}

/**
 * أسماء دخول قصيرة وأرقام سرية يحددها المدير. لا تُحفظ الأرقام في الكود، بل في ورقة مؤقتة:
 * أنشئ ورقة باسم Credentials، أعمدتها: name | password | username | account | email | branch | change
 *   name      الاسم كما تعرفه (Emilia …)
 *   password  الرقم السري أو كلمة المرور (3 خانات على الأقل)
 *   username  اسم الدخول القصير (اختياري، الافتراضي الاسم الأول)
 *   account   بريد الحساب الصحيح إن لم يتعرف الاسم عليه أو تطابق أكثر من حساب (اختياري)
 *   email + branch   لإنشاء ممرضة جديدة ليس لها حساب (BURIDAH أو ONIZAH) (اختياري)
 *   change    yes = تُطلب منها كلمة مرور جديدة عند أول دخول (الافتراضي no)
 * 1) شغّل previewCredentials: يكتب في عمود result لمن ستُطبَّق كل كلمة، بدون أي تغيير.
 * 2) إذا صحّت، شغّل applyCredentials. ثم احذف الورقة لأن فيها كلمات المرور.
 * الحساب غير النشط يُفعَّل عند إعطائه كلمة مرور.
 */
function previewCredentials() { return processCredentials_(true); }

/**
 * يجرّب الدخول لكل صف في ورقة Credentials (اسم الدخول من عمود username أو الاسم + الرقم السري)
 * ويكتب في عمود check: ✓ أو سبب الفشل بالضبط. لا يغيّر شيئاً ولا يحسب محاولات خاطئة.
 */
function checkCredentials() {
  const sh = ss_().getSheetByName('Credentials');
  if (!sh) throw new Error('لا توجد ورقة Credentials');
  const data = sh.getDataRange().getValues();
  const head = data.shift().map(h => String(h).trim().toLowerCase());
  const col = k => head.indexOf(k);
  let cc = col('check'); if (cc < 0) { cc = head.length; sh.getRange(1, cc + 1).setValue('check'); }
  const cache = CacheService.getScriptCache();
  let good = 0, bad = 0;
  data.forEach((row, i) => {
    const get = k => col(k) < 0 ? '' : String(row[col(k)] == null ? '' : row[col(k)]).trim();
    if (!get('name') && !get('password')) return;
    const id = get('username') || get('name'), pw = get('password');
    const cands = loginCandidates_(id);
    const u = pickLoginUser_(cands, pw);
    let msg;
    if (!u) {
      // نوضح السبب: هل الحساب نفسه موجود؟ وما اسم الدخول المسجّل له فعلاً؟
      const nurses = rows_(S.USERS).filter(x => x.role === 'nurse');
      const m = matchNurseByName_(get('account') || get('name'), nurses);
      if (m.err) msg = '✗ لا يوجد حساب باسم الدخول «' + id + '»، ولا حساب يطابق «' + (get('account') || get('name')) + '»: ' + m.err;
      else if (m.user.login) msg = '✗ اسم الدخول المسجّل لـ ' + m.user.name + ' هو «' + m.user.login + '» وليس «' + id + '». شغّل applyCredentials مرة أخرى أو استخدم «' + m.user.login + '»';
      else msg = '✗ الحساب موجود (' + m.user.name + ' · ' + (m.user.email || m.user.username) + ') لكن لم يُطبَّق عليه الرقم بعد. شغّل applyCredentials وانظر عمود result لهذا الصف';
    }
    else if (u.status !== 'active') msg = '✗ الحساب (' + u.name + ') غير نشط/ترك العمل';
    else if (!u.pass_hash || hash_(pw, u.salt) !== u.pass_hash) msg = '✗ الرقم السري لا يطابق حساب ' + u.name + '. شغّل applyCredentials مرة أخرى';
    else if (Number(cache.get('fail_' + String(u.username).toLowerCase()) || 0) >= APP.MAX_LOGIN_FAILS) msg = '✗ مقفل مؤقتاً بعد محاولات خاطئة: شغّل clearLoginLocks';
    else msg = '✓ يدخل بـ «' + (u.login || id) + '» → ' + u.name + (cands.length > 1 ? ' (تنبيه: ' + cands.length + ' حسابات بنفس الاسم)' : '');
    if (msg[0] === '✓') good++; else bad++;
    sh.getRange(i + 2, cc + 1).setValue(msg);
  });
  SpreadsheetApp.getActive().toast('فحص الدخول: ' + good + ' يعمل · ' + bad + ' لا يعمل. انظر عمود check', APP.NAME, 12);
  return { ok: good, failed: bad };
}
function applyCredentials() { return processCredentials_(false); }

function processCredentials_(dryRun) {
  const sh = ss_().getSheetByName('Credentials');
  if (!sh) throw new Error('أنشئ ورقة باسم Credentials وضع فيها الأعمدة: name | password | username | account | email | branch | change');
  const data = sh.getDataRange().getValues();
  const head = data.shift().map(h => String(h).trim().toLowerCase());
  const col = k => head.indexOf(k);
  if (col('name') < 0 || col('password') < 0) throw new Error('العمودان name وpassword مطلوبان في الصف الأول');
  let resCol = col('result'); if (resCol < 0) { resCol = head.length; sh.getRange(1, resCol + 1).setValue('result'); }

  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse');
  const usedLogins = {}, usedAccounts = {};
  let ok = 0, bad = 0;
  data.forEach((row, i) => {
    const get = k => col(k) < 0 ? '' : String(row[col(k)] == null ? '' : row[col(k)]).trim();
    if (!get('name') && !get('password')) return;
    const say = msg => sh.getRange(i + 2, resCol + 1).setValue(msg);
    const fail = msg => { bad++; say(msg); };
    const pw = get('password');
    if (pw.length < 3 || pw.length > 60) return fail('كلمة المرور يجب أن تكون 3 خانات على الأقل');

    let m = matchNurseByName_(get('account') || get('name'), nurses);
    // إيميل ممرضة جديدة كُتب في عمود account بدل email: نعامله كإيميل الحساب الجديد
    const acctIsNewEmail = m.err && /@/.test(get('account')) && !get('email');
    const email = (acctIsNewEmail ? get('account') : get('email')).toLowerCase();
    const branch = (get('branch').toUpperCase().indexOf('ONI') >= 0 || /عنيزة/.test(get('branch'))) ? 'ONIZAH'
      : (get('branch').toUpperCase().indexOf('BUR') >= 0 || /بريدة/.test(get('branch'))) ? 'BURIDAH' : get('branch').toUpperCase();
    if (acctIsNewEmail && !BRANCHES[branch]) return fail('ممرضة جديدة (لا يوجد حساب بهذا الإيميل): اكتب الفرع في عمود branch (BURIDAH أو ONIZAH)');
    let create = false;
    if (m.err && (!get('account') || acctIsNewEmail) && email && BRANCHES[branch]) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('البريد غير صحيح');
      if (loginsTaken_()[email]) return fail('هذا البريد مستخدم لحساب آخر');
      create = true; m = { user: { name: get('name'), username: email, email: email, branch: branch, role: 'nurse', status: 'active' } };
    }
    if (m.err) return fail(m.err);
    if (!create && usedAccounts[m.user.username]) return fail('نفس الحساب (' + m.user.name + ') سبق ذكره في الصف ' + usedAccounts[m.user.username] + '. اكتب بريد الصحيح في عمود account');

    const taken = Object.assign(create ? loginsTaken_() : loginsTaken_(m.user.username), usedLogins);
    const login = loginNameFor_(m.user, taken, get('username'));
    if (!login) return fail('اسم الدخول مكرر أو قصير (3 خانات على الأقل): اكتب اسماً آخر في عمود username');
    usedLogins[login] = 1; if (!create) usedAccounts[m.user.username] = i + 2;

    const wasInactive = !create && m.user.status !== 'active';
    const label = (create ? 'حساب جديد: ' : '') + m.user.name + ' ← ' + login + (wasInactive ? ' (كان غير نشط وسيُفعَّل)' : '');
    if (dryRun) { ok++; return say('سيُطبَّق على: ' + label); }

    const f = passwordFields_(pw, get('change').toLowerCase() === 'yes', login);
    if (create) {
      const base = newUserRow_({ username: m.user.username, name: m.user.name, email: email, role: 'nurse', branch: branch }).row;
      const row2 = Object.assign(base, f);
      appendObjects_(S.USERS, [row2]); nurses.push(row2);
    } else {
      setCells_(S.USERS, m.user._row, Object.assign(f, wasInactive ? { status: 'active', end_date: '' } : {}));
    }
    log_('admin', 'credentials_set', m.user.username + ' → ' + login);
    ok++; say('تم: ' + label);
  });
  SpreadsheetApp.getActive().toast((dryRun ? 'معاينة: ' : 'تم: ') + ok + ' صحيح · ' + bad + ' يحتاج مراجعة. انظر عمود result' + (dryRun ? '' : ' ثم احذف ورقة Credentials'), APP.NAME, 12);
  return { ok: ok, failed: bad, dryRun: !!dryRun };
}

/**
 * دمج حسابات مكررة وربط الأسماء المختلفة بصاحبتها، بدون تعديل يدوي على Users أو Reports.
 * أنشئ ورقة باسم Merges، أعمدتها: from | into
 *   into  الممرضة الصحيحة (إيميلها أو اسم الدخول أو اسمها كما في Users)
 *   from  الحساب المكرر، أو اسم/إيميل كُتب به في النموذج (مثل Ma.Clarissa Tugano أو tugano34@gmail.com)
 * 1) previewMerges: يكتب في عمود result ما سيحدث، بدون أي تغيير.
 * 2) applyMerges: ينقل تقارير الحساب المكرر وبلاغاته وإجازاته إلى الصحيحة، ويضيف الاسم/الإيميل إلى aliases،
 *    ويوقف الحساب المكرر (لا يُحذف)، ثم يعيد ربط ردود النموذج المعلّقة.
 */
function previewMerges() { return processMerges_(true); }
function applyMerges() { return processMerges_(false); }

/** مطابقة حرفية فقط (اسم المستخدم، الإيميل، اسم الدخول، الاسم أو أحد الأسماء البديلة) */
function findNurseExact_(raw, nurses) {
  const q = normText_(raw);
  if (!q) return [];
  return nurses.filter(u => [u.username, u.email, u.login, u.name].concat(splitList_(u.aliases)).some(k => k && normText_(k) === q));
}

function processMerges_(dryRun) {
  const sh = ss_().getSheetByName('Merges');
  if (!sh) throw new Error('أنشئ ورقة باسم Merges وفيها العمودان: from | into');
  const data = sh.getDataRange().getValues();
  const head = data.shift().map(h => String(h).trim().toLowerCase());
  const cf = head.indexOf('from'), ci = head.indexOf('into');
  if (cf < 0 || ci < 0) throw new Error('العمودان from وinto مطلوبان في الصف الأول');
  let resCol = head.indexOf('result'); if (resCol < 0) { resCol = head.length; sh.getRange(1, resCol + 1).setValue('result'); }

  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse');
  const moves = {};        // اسم المستخدم القديم ← الحساب الصحيح
  const aliasAdd = {};     // اسم المستخدم الصحيح ← أسماء/إيميلات تُضاف إلى aliases
  let ok = 0, bad = 0;
  data.forEach((row, i) => {
    const from = String(row[cf] || '').trim(), into = String(row[ci] || '').trim();
    if (!from && !into) return;
    const say = m => sh.getRange(i + 2, resCol + 1).setValue(m);
    const fail = m => { bad++; say(m); };
    const t = findNurseExact_(into, nurses);
    if (t.length !== 1) return fail(t.length ? 'into يطابق أكثر من حساب: ' + t.map(u => u.name + ' (' + (u.email || u.username) + ')').join(' / ') + '. اكتب الإيميل' : 'into: لا يوجد حساب بهذا الاسم أو الإيميل');
    const target = t[0];
    const src = findNurseExact_(from, nurses).filter(u => u.username !== target.username);
    if (src.length > 1) return fail('from يطابق أكثر من حساب: ' + src.map(u => u.name + ' (' + (u.email || u.username) + ')').join(' / ') + '. اكتب الإيميل');
    const add = aliasAdd[target.username] = aliasAdd[target.username] || [];
    if (src.length) {
      const f = src[0];
      if (moves[f.username]) return fail('هذا الحساب مذكور في صف سابق');
      const n = rows_(S.REPORTS).filter(r => r.username === f.username).length;
      moves[f.username] = target;
      add.push(f.name); if (f.email) add.push(f.email); else if (f.username.indexOf('@') > 0) add.push(f.username);
      splitList_(f.aliases).forEach(a => add.push(a));
      ok++; say((dryRun ? 'سيُدمج' : 'تم دمج') + ' حساب ' + f.name + ' (' + n + ' تقرير) في ' + target.name);
    } else {
      if (findNurseExact_(from, [target]).length) { ok++; return say('مربوط بها مسبقاً: ' + target.name); }
      add.push(from);
      ok++; say((dryRun ? 'سيُضاف' : 'أُضيف') + ' «' + from + '» كاسم بديل لـ ' + target.name + ' (ردود النموذج بهذا الاسم تُنسب لها)');
    }
  });
  if (dryRun) {
    SpreadsheetApp.getActive().toast('معاينة: ' + ok + ' صحيح · ' + bad + ' يحتاج مراجعة. انظر عمود result', APP.NAME, 12);
    return { ok: ok, failed: bad, dryRun: true };
  }

  // نقل التقارير والبلاغات والإجازات دفعة واحدة لكل ورقة
  const rewrite = (name, cols) => {
    const sheet = sh_(name), last = sheet.getLastRow();
    if (last < 2) return;
    const h = HEADERS[name], ui = h.indexOf('username'), ni = h.indexOf('nurse_name');
    const rg = sheet.getRange(2, 1, last - 1, h.length), vals = rg.getValues();
    let changed = false;
    const ri = h.indexOf('reporters');
    vals.forEach(v => {
      const t = moves[String(v[ui]).trim()];
      if (t) { v[ui] = t.username; if (ni >= 0) v[ni] = t.name; changed = true; }
      if (ri >= 0 && v[ri]) { const rp = unique_(splitList_(v[ri]).map(x => moves[x] ? moves[x].username : x)).join(','); if (rp !== v[ri]) { v[ri] = rp; changed = true; } }
    });
    if (changed) [ui, ni, ri].filter(c => c >= 0).forEach(c => sheet.getRange(2, c + 1, vals.length, 1).setValues(vals.map(v => [v[c]])));
    delete ROWS_CACHE_[name];
  };
  if (Object.keys(moves).length) [S.REPORTS, S.ISSUES, S.LEAVES].forEach(n => rewrite(n));

  rows_(S.USERS).forEach(u => {
    const add = aliasAdd[u.username];
    if (add) {
      const have = splitList_(u.aliases);
      const mine = [u.name, u.email, u.username].map(normText_);
      add.forEach(a => { if (a && mine.indexOf(normText_(a)) < 0 && !have.some(x => normText_(x) === normText_(a))) have.push(a); });
      const upd = { aliases: have.join(', ') };
      // إن كان للحساب المكرر اسم دخول ورقم سري ولم يكن للصحيح، ينتقلان إليه
      Object.keys(moves).forEach(old => {
        if (moves[old].username !== u.username || u.login) return;
        const f = nurses.find(x => x.username === old);
        if (f && f.login) Object.assign(upd, { login: f.login, pass_hash: f.pass_hash, salt: f.salt, must_change: f.must_change });
      });
      const f0 = Object.keys(moves).map(o => nurses.find(x => x.username === o)).filter(f => f && moves[f.username].username === u.username);
      f0.forEach(f => { if (f.start_date && (!u.start_date || String(f.start_date) < String(u.start_date))) upd.start_date = f.start_date; });
      setCells_(S.USERS, u._row, upd);
    }
    if (moves[u.username]) {
      setCells_(S.USERS, u._row, { username: 'merged:' + u.username, role: 'merged', status: 'inactive', login: '', pass_hash: '', email: '',
        aliases: 'دُمج في ' + moves[u.username].username });
    }
  });
  log_('admin', 'merge_nurses', Object.keys(moves).map(k => k + ' → ' + moves[k].username).join('; ') + ' | aliases: ' + Object.keys(aliasAdd).length);
  importFormResponses();   // يربط ردود النموذج المعلّقة بالأسماء البديلة الجديدة
  return { ok: ok, failed: bad, dryRun: false };
}

/**
 * يولّد لكل ممرضة نشطة لم تسجّل دخولها بعد (ما زالت على كلمتها المؤقتة) اسم دخول قصيراً ورقماً سرياً من 4 خانات،
 * ويكتبها في ورقة Logins لتوزيعها. من غيّرت كلمتها بنفسها لا تُمَس. احذف الورقة بعد التوزيع.
 */
function generateNursePins() {
  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse' && u.status === 'active' && u.must_change === 'yes');
  const used = {}, out = [['name', 'username', 'password', 'branch']];
  nurses.forEach(u => {
    const login = loginNameFor_(u, Object.assign(loginsTaken_(u.username), used), u.login);
    if (!login) return;
    used[login] = 1;
    const pin = String(1000 + parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 9000);
    setCells_(S.USERS, u._row, passwordFields_(pin, false, login));
    out.push([u.name, login, pin, u.branch]);
  });
  const ss = ss_();
  const old = ss.getSheetByName('Logins');
  const sh = old || ss.insertSheet('Logins');
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 1), 4).clearContent();
  sh.getRange(1, 1, out.length, 4).setNumberFormat('@').setValues(out);
  log_('admin', 'pins_generated', String(out.length - 1));
  SpreadsheetApp.getActive().toast('تم توليد ' + (out.length - 1) + ' حساب. وزّعها من ورقة Logins ثم احذفها', APP.NAME, 12);
  return { count: out.length - 1 };
}

/* ───────── حالة الممرضة: على رأس العمل / إجازة / متوقفة ───────── */

function apiUserSetStatus_(req, user) {
  const st = req.status;
  if (['active', 'leave', 'inactive'].indexOf(st) < 0) throw err_('حالة غير صحيحة');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const u = rows_(S.USERS).find(x => x.username === req.username);
    if (!u || u.role !== 'nurse') throw err_('الممرضة غير موجودة');
    if (!branchAllowed_(user, u.branch)) throw err_('ليست لديك صلاحية على هذا الفرع', 'FORBIDDEN');
    const today = dateStr_(new Date());
    const open = rows_(S.LEAVES).filter(l => l.username === u.username && l.cancelled !== 'yes' && l.to_date >= today);
    const yesterday = dateStr_(addDays_(parseDate_(today), -1));
    const closeLeaves = () => open.forEach(l => {
      if (l.from_date >= today) setCell_(S.LEAVES, l._row, 'cancelled', 'yes');   // لم تبدأ بعد: تُلغى
      else setCell_(S.LEAVES, l._row, 'to_date', yesterday);                       // بدأت: تنتهي أمس
    });

    if (st === 'leave') {
      const from = parseDate_(req.leave_from), to = parseDate_(req.leave_to);
      if (!from || !to) throw err_('حدد تاريخ بداية الإجازة ونهايتها');
      if (to < from) throw err_('تاريخ نهاية الإجازة قبل بدايتها');
      if (daysBetween_(from, to) > 400) throw err_('مدة الإجازة طويلة جداً، تحقق من التواريخ');
      if (open.length) {
        setCells_(S.LEAVES, open[0]._row, { from_date: dateStr_(from), to_date: dateStr_(to) });   // تمديد أو تعديل
        open.slice(1).forEach(l => setCell_(S.LEAVES, l._row, 'cancelled', 'yes'));
      } else {
        appendObjects_(S.LEAVES, [{ leave_id: 'L' + Utilities.formatDate(new Date(), APP.TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10),
          username: u.username, from_date: dateStr_(from), to_date: dateStr_(to), cancelled: '', created_at: nowStr_(), created_by: user.name }]);
      }
      setCells_(S.USERS, u._row, { status: 'active', end_date: '' });
    } else if (st === 'inactive') {
      closeLeaves();
      // آخر أسبوع مطلوب منها هو الأسبوع السابق للجاري، فلا يُحسب عليها التقرير الحالي
      setCells_(S.USERS, u._row, { status: 'inactive', end_date: dateStr_(addDays_(parseDate_(currentWeek_(settings_())), -1)) });
    } else {
      closeLeaves();
      setCells_(S.USERS, u._row, { status: 'active', end_date: '' });
    }
    log_(user.username, 'status_' + st, u.username + (st === 'leave' ? ' ' + req.leave_from + '→' + req.leave_to : ''));
    delete ROWS_CACHE_[S.LEAVES]; delete ROWS_CACHE_[S.USERS];
    const fresh = nurseState_(rows_(S.USERS).find(x => x.username === u.username), (leavesMap_()[u.username] || []), today);
    return { username: u.username, state: fresh.state, leave: fresh.leave };
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════════════ QUALITY / STATS ════════════════════════════ */

function apiQualityStats_(req, user) {
  const cfg = settings_();
  const to = normalizeWeek_(req.to || req.week, cfg);
  const branch = req.branch && req.branch !== 'ALL' ? req.branch : null;
  const inScope = b => branchAllowed_(user, b) && (!branch || b === branch);
  const from = req.from === 'all' ? firstWeek_({ role: user.role, branch: branch || user.branch }, to)
    : req.from ? normalizeWeek_(req.from, cfg) : dateStr_(addDays_(parseDate_(to), -7 * 11));

  const weeks = [];
  for (let d = parseDate_(from); dateStr_(d) <= to; d = addDays_(d, 7)) weeks.push(dateStr_(d));

  const reports = rows_(S.REPORTS).filter(r => inScope(r.branch) && r.week_start >= from && r.week_start <= to);
  const issues = rows_(S.ISSUES).filter(i => inScope(i.branch));
  const clinics = clinics_().filter(c => c.status === 'active' && inScope(c.branch));
  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse' && inScope(u.branch));
  const lm = leavesMap_();

  // نسبة النجاح لكل بند فحص
  const pass = (key, okVal, skip) => {
    const rs = reports.filter(r => !skip || !skip(r));
    return rs.length ? Math.round(rs.filter(r => okVal(r[key])).length / rs.length * 100) : null;
  };
  const checks = [
    { key: 'expiry_checked', label: 'فحص الصلاحية', rate: pass('expiry_checked', v => v === 'yes') },
    { key: 'sterilization_ok', label: 'التعقيم والأكياس', rate: pass('sterilization_ok', v => v === 'yes') },
    { key: 'fridge', label: 'الثلاجة', rate: pass('fridge', v => v === 'ok', r => r.fridge === 'none') },
    { key: 'employee_card', label: 'بطاقة الموظف', rate: pass('employee_card', v => v === 'yes') },
    { key: 'cleanliness', label: 'النظافة (4–5)', rate: pass('cleanliness', v => Number(v) >= 4) },
    { key: 'missing_tools', label: 'اكتمال الأدوات', rate: pass('missing_tools', v => v === 'no') },
  ];

  // الاتجاه الأسبوعي لكل فرع
  const branchKeys = Object.keys(BRANCHES).filter(b => inScope(b));
  const trend = weeks.map(w => {
    const row = { week: w };
    branchKeys.forEach(b => {
      const expected = nurses.filter(n => n.branch === b && expectedOn_(n, w, lm[n.username], cfg)).length;
      const submitted = unique_(reports.filter(r => r.branch === b && r.week_start === w).map(r => r.username)).length;
      row[b] = expected ? Math.min(100, Math.round(submitted / expected * 100)) : null;
      row[b + '_reports'] = reports.filter(r => r.branch === b && r.week_start === w).length;
    });
    return row;
  });

  // تغطية العيادات للأسبوع الأخير
  const lastWeekReports = reports.filter(r => r.week_start === to);
  const coverage = clinics.map(c => {
    const rep = lastWeekReports.find(r => r.clinic_id === c.clinic_id);
    const lastAny = reports.filter(r => r.clinic_id === c.clinic_id).reduce((m, r) => r.week_start > m ? r.week_start : m, '');
    return { clinic_id: c.clinic_id, name: c.name, branch: c.branch, covered: !!rep,
             nurse: rep ? rep.nurse_name : '', timing: rep ? rep.timing : '', lastWeek: lastAny };
  });

  // الصلاحيات القريبة (آخر تقرير لكل عيادة)
  const latestByClinic = {};
  rows_(S.REPORTS).filter(r => inScope(r.branch)).forEach(r => {
    const p = latestByClinic[r.clinic_id];
    if (!p || r.submitted_at > p.submitted_at) latestByClinic[r.clinic_id] = r;
  });
  const today = new Date();
  const expiry = Object.keys(latestByClinic).map(k => latestByClinic[k])
    .filter(r => r.earliest_expiry)
    .map(r => ({ clinic_id: r.clinic_id, clinic_name: r.clinic_name, branch: r.branch, item: r.expiry_item,
                 date: r.earliest_expiry, days: daysBetween_(today, parseDate_(r.earliest_expiry)),
                 reported: r.submitted_at, nurse: r.nurse_name }))
    .filter(x => x.days <= Math.max(cfg.EXPIRY_ALERT_DAYS, 90))
    .sort((a, b) => a.days - b.days);

  // المشاكل
  const inRange = i => i.week_start >= from && i.week_start <= to;
  const openIssues = issues.filter(i => i.status === 'open' || i.status === 'in_progress');
  const byCategory = Object.keys(CATEGORIES).map(c => ({
    category: c, label: CATEGORIES[c].label,
    raised: issues.filter(i => i.category === c && inRange(i)).length,
    open: openIssues.filter(i => i.category === c).length,
  })).filter(x => x.raised || x.open);

  const resolved = issues.filter(i => i.status === 'resolved' && i.resolved_at && inRange(i));
  const avgResolveDays = resolved.length
    ? Math.round(resolved.reduce((s, i) => s + Math.max(0, daysBetween_(parseDateTime_(i.created_at), parseDateTime_(i.resolved_at))), 0) / resolved.length * 10) / 10
    : null;

  const recurring = openIssues.filter(i => Number(i.occurrences) >= 2)
    .sort((a, b) => Number(b.occurrences) - Number(a.occurrences)).slice(0, 25).map(issueOut_);

  // ترتيب الممرضات خلال الفترة
  const nurseStats = nurses.map(n => {
    const eligible = weeks.filter(w => expectedOn_(n, w, lm[n.username], cfg));
    const mine = reports.filter(r => r.username === n.username);
    const doneWeeks = unique_(mine.map(r => r.week_start)).filter(w => eligible.indexOf(w) >= 0);
    const onTimeWeeks = eligible.filter(w => ['on_time', 'early'].indexOf(bestTiming_(mine.filter(r => r.week_start === w))) >= 0);
    return { name: n.name, branch: n.branch, expected: eligible.length, submitted: doneWeeks.length,
             rate: eligible.length ? Math.min(100, Math.round(doneWeeks.length / eligible.length * 100)) : null,
             onTime: eligible.length ? Math.round(onTimeWeeks.length / eligible.length * 100) : null,
             reports: mine.length, issues: mine.reduce((s, r) => s + Number(r.issues_count || 0), 0) };
  }).filter(n => n.expected > 0).sort((a, b) => (b.rate || 0) - (a.rate || 0));

  const expectedTotal = nurseStats.reduce((s, n) => s + n.expected, 0);
  const submittedTotal = nurseStats.reduce((s, n) => s + Math.min(n.submitted, n.expected), 0);

  // ── كل ما يخص الجودة: بطاقة أداء كل قسم، حرارة الثلاجات، سجل المخالفات، وطابور مشاكل الجودة ──
  const avg1 = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
  const clinicsScore = clinics.map(c => {
    const rs = reports.filter(r => r.clinic_id === c.clinic_id);
    const cnt = f => rs.filter(f).length;
    const mine = openIssues.filter(i => i.clinic_id === c.clinic_id);
    const wks = unique_(rs.map(r => r.week_start)).length;
    return { clinic_id: c.clinic_id, name: c.name, branch: c.branch, type: c.type,
      reports: rs.length, coverage: weeks.length ? Math.min(100, Math.round(wks / weeks.length * 100)) : null,
      avgClean: avg1(rs.map(r => Number(r.cleanliness)).filter(x => x > 0)),
      steril: cnt(r => r.sterilization_ok === 'no'), fridge: cnt(r => r.fridge === 'problem'),
      expiryUnchecked: cnt(r => r.expiry_checked === 'no'), cards: cnt(r => r.employee_card === 'no'),
      tools: cnt(r => r.missing_tools === 'yes'), openIssues: mine.length, highOpen: mine.filter(i => i.severity === 'high').length };
  }).sort((a, b) => b.highOpen - a.highOpen || b.openIssues - a.openIssues || a.coverage - b.coverage);

  const temps = reports.filter(r => r.fridge_temp !== '' && r.fridge_temp != null && isFinite(Number(r.fridge_temp)));
  const outTemps = temps.filter(r => Number(r.fridge_temp) < cfg.FRIDGE_MIN || Number(r.fridge_temp) > cfg.FRIDGE_MAX);
  const fridge = {
    range: [cfg.FRIDGE_MIN, cfg.FRIDGE_MAX], readings: temps.length, outOfRange: outTemps.length,
    avg: avg1(temps.map(r => Number(r.fridge_temp))), problems: reports.filter(r => r.fridge === 'problem').length,
    outList: outTemps.sort((a, b) => a.submitted_at < b.submitted_at ? 1 : -1).slice(0, 30)
      .map(r => ({ date: r.submitted_at, clinic: r.clinic_name, branch: r.branch, nurse: r.nurse_name, temp: Number(r.fridge_temp) })),
  };

  const incidents = [];
  reports.forEach(r => {
    const what = [];
    if (r.expiry_checked === 'no') what.push('لم يُفحص تاريخ الانتهاء');
    if (r.sterilization_ok === 'no') what.push('التعقيم/الأكياس');
    if (r.fridge === 'problem') what.push('الثلاجة: مشكلة');
    if (r.fridge_temp !== '' && r.fridge_temp != null && isFinite(Number(r.fridge_temp)) && (Number(r.fridge_temp) < cfg.FRIDGE_MIN || Number(r.fridge_temp) > cfg.FRIDGE_MAX)) what.push('حرارة الثلاجة ' + r.fridge_temp + '°');
    if (r.employee_card === 'no') what.push('بطاقة الموظف');
    if (Number(r.cleanliness) > 0 && Number(r.cleanliness) <= 3) what.push('النظافة ' + r.cleanliness + '/5');
    if (r.missing_tools === 'yes') what.push('أدوات ناقصة');
    if (r.other_issue) what.push('أخرى: ' + String(r.other_issue).slice(0, 60));
    if (what.length) incidents.push({ date: r.submitted_at, clinic: r.clinic_name, branch: r.branch, nurse: r.nurse_name, what: what });
  });
  incidents.sort((a, b) => a.date < b.date ? 1 : -1);

  const issuesByDept = { supply: 0, quality: 0, hr: 0 };
  openIssues.forEach(i => { if (issuesByDept[i.department] != null) issuesByDept[i.department]++; });
  const qualityQueue = openIssues.filter(i => i.department === 'quality')
    .sort((a, b) => sevRank_(b.severity) - sevRank_(a.severity) || (a.created_at < b.created_at ? -1 : 1)).slice(0, 40).map(issueOut_);

  return {
    clinicsScore: clinicsScore, fridge: fridge, incidents: incidents.slice(0, 150), incidentsTotal: incidents.length,
    issuesByDept: issuesByDept, qualityQueue: qualityQueue,
    from: from, to: to, weeks: weeks, branches: branchKeys,
    kpi: {
      reports: reports.length,
      compliance: expectedTotal ? Math.round(submittedTotal / expectedTotal * 100) : null,
      onTime: reports.length ? Math.round(reports.filter(r => r.timing === 'on_time' || r.timing === 'early').length / reports.length * 100) : null,
      openIssues: openIssues.length,
      highOpen: openIssues.filter(i => i.severity === 'high').length,
      expiringSoon: expiry.filter(x => x.days <= 30).length,
      avgResolveDays: avgResolveDays,
      coverage: coverage.length ? Math.round(coverage.filter(c => c.covered).length / coverage.length * 100) : null,
    },
    checks: checks, trend: trend, coverage: coverage, expiry: expiry,
    byCategory: byCategory, recurring: recurring, nurses: nurseStats,
  };
}

function apiReportsList_(req, user) {
  const cfg = settings_();
  const to = normalizeWeek_(req.to || req.week, cfg);
  const from = req.from === 'all' ? firstWeek_(user, to) : req.from ? normalizeWeek_(req.from, cfg) : to;
  const list = rows_(S.REPORTS)
    .filter(r => branchAllowed_(user, r.branch) && r.week_start >= from && r.week_start <= to)
    .filter(r => !req.branch || req.branch === 'ALL' || r.branch === req.branch)
    .sort((a, b) => a.submitted_at < b.submitted_at ? 1 : -1)
    .map(reportOut_);
  return { from: from, to: to, reports: list };
}

/* ════════════════════════════ ISSUES (SUPPLY / QUALITY / HR) ════════════════════════════ */

function apiIssuesList_(req, user) {
  const dept = (user.role === 'supply' || user.role === 'hr') ? user.role : req.department;   // الأقسام ترى مشاكلها فقط
  const statuses = req.status ? [].concat(req.status) : ['open', 'in_progress'];
  const list = rows_(S.ISSUES)
    .filter(i => branchAllowed_(user, i.branch))
    .filter(i => !dept || dept === 'all' || i.department === dept)
    .filter(i => statuses.indexOf(i.status) >= 0)
    .filter(i => !req.branch || req.branch === 'ALL' || i.branch === req.branch)
    .map(issueOut_)
    .sort((a, b) => sevRank_(b.severity) - sevRank_(a.severity) || (a.created_at < b.created_at ? -1 : 1));

  // ملخص النواقص مجمّع حسب الصنف (لطلب الشراء)
  const shortage = {};
  list.filter(i => i.category === 'tools').forEach(i => {
    const k = normText_(i.item);
    const s = shortage[k] = shortage[k] || { item: i.item, qty: 0, clinics: [], branches: [], high: 0 };
    s.qty += Number(i.qty) || 1;
    if (s.clinics.indexOf(i.clinic_name + ' — ' + (BRANCHES[i.branch] || i.branch)) < 0) s.clinics.push(i.clinic_name + ' — ' + (BRANCHES[i.branch] || i.branch));
    if (s.branches.indexOf(i.branch) < 0) s.branches.push(i.branch);
    if (i.severity === 'high') s.high++;
  });

  return {
    issues: list,
    shortage: Object.keys(shortage).map(k => shortage[k]).sort((a, b) => b.high - a.high || b.qty - a.qty),
    categories: CATEGORIES,
  };
}

function apiIssueUpdate_(req, user) {
  const status = req.status;
  if (ISSUE_STATUS.indexOf(status) < 0) throw err_('حالة غير صحيحة');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const i = rows_(S.ISSUES).find(x => x.issue_id === req.issue_id);
    if (!i) throw err_('المشكلة غير موجودة');
    if (!branchAllowed_(user, i.branch)) throw err_('ليست لديك صلاحية على هذا الفرع', 'FORBIDDEN');
    if (user.role !== 'admin' && user.role !== 'quality' && i.department !== user.role) {
      throw err_('هذه المشكلة من اختصاص قسم آخر', 'FORBIDDEN');
    }
    if (status === 'resolved' && !String(req.resolution || '').trim()) throw err_('اكتب ما تم لحل المشكلة');
    const patch = { status: status, updated_at: nowStr_(), updated_by: user.name };
    if (req.assigned_to != null) patch.assigned_to = clean_(req.assigned_to, 80);
    if (req.resolution != null) patch.resolution = clean_(req.resolution, 500);
    patch.resolved_at = status === 'resolved' ? nowStr_() : '';
    setCells_(S.ISSUES, i._row, patch);
    log_(user.username, 'issue_' + status, i.issue_id);
    return { issue: issueOut_(Object.assign(i, patch)) };
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════════════ USERS & CLINICS ════════════════════════════ */

function apiUsersList_(req, user) {
  const lm = leavesMap_(), today = dateStr_(new Date());
  const list = rows_(S.USERS)
    .filter(u => u.role !== 'merged' && (user.role === 'admin' || u.role === 'nurse'))
    .filter(u => branchAllowed_(user, u.branch) || u.branch === 'ALL' && user.role === 'admin')
    .map(u => {
      const st = nurseState_(u, lm[u.username], today);
      return { username: u.username, login: u.login || '', name: u.name, email: u.email, role: u.role, branch: u.branch,
               clinics: splitList_(u.clinics), status: u.status, state: u.role === 'nurse' ? st.state : u.status, leave: st.leave,
               start_date: dateStr_(parseDate_(u.start_date)) || '', last_login: u.last_login, must_change: u.must_change === 'yes' };
    });
  return { users: list, clinics: clinics_(), roles: ROLES, branches: BRANCHES };
}

function apiUserSave_(req, user) {
  const p = req.user || {};
  const role = p.role || 'nurse';
  if (!ROLES[role]) throw err_('دور غير صحيح');
  if (user.role !== 'admin' && role !== 'nurse') throw err_('الموارد البشرية تدير حسابات الممرضات فقط', 'FORBIDDEN');
  const branch = p.branch === 'ALL' || BRANCHES[p.branch] ? p.branch : null;
  if (!branch) throw err_('اختر الفرع');
  if (!branchAllowed_(user, branch)) throw err_('ليست لديك صلاحية على هذا الفرع', 'FORBIDDEN');
  const name = clean_(p.name, 80);
  const email = clean_(p.email, 120).toLowerCase();
  if (!name) throw err_('أدخل الاسم');
  if (role === 'nurse' && !p.username && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('أدخل بريداً إلكترونياً صحيحاً للممرضة، تصلها عليه تذكيرات التقرير');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err_('البريد الإلكتروني غير صحيح');
  if (p.newUsername && !/^[a-z0-9._@+-]{3,80}$/i.test(String(p.newUsername).trim())) throw err_('اسم المستخدم: أحرف إنجليزية وأرقام و . _ - فقط (3 خانات على الأقل)');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const users = rows_(S.USERS);
    const existing = p.username ? users.find(u => u.username === p.username) : null;
    const clinicsStr = (Array.isArray(p.clinics) ? p.clinics : []).join(',');
    if (existing) {
      if (user.role !== 'admin' && existing.role !== 'nurse') throw err_('لا يمكن تعديل هذا الحساب', 'FORBIDDEN');
      if (name !== existing.name) {
        const clash = existing.role === 'nurse' && nameClash_(existing, name, users.filter(x => x.role === 'nurse'));
        if (clash) throw err_('الاسم «' + name + '» مستخدم لحساب آخر (' + (clash.email || clash.username) + '). إن كانتا نفس الممرضة ادمجهما أولاً');
        renameNurse_(existing, name);
      }
      setCells_(S.USERS, existing._row, {
        email: email, role: role, branch: branch, clinics: clinicsStr,
        start_date: p.start_date ? dateStr_(parseDate_(p.start_date)) : existing.start_date,
      });
      log_(user.username, 'user_update', existing.username);
      return { username: existing.username };
    }
    let username = clean_(p.newUsername || email || name.replace(/\s+/g, '.'), 120).toLowerCase();
    if (users.some(u => u.username === username || (email && u.email === email))) throw err_('اسم المستخدم أو البريد مستخدم مسبقاً');
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    appendObjects_(S.USERS, [{
      username: username, name: name, email: email, role: role, branch: branch, clinics: clinicsStr,
      status: 'active', start_date: p.start_date ? dateStr_(parseDate_(p.start_date)) : dateStr_(new Date()),
      pass_hash: hash_(temp, salt), salt: salt, must_change: 'yes', created_at: nowStr_(), last_login: '',
    }]);
    log_(user.username, 'user_create', username);
    return { username: username, tempPassword: temp };
  } finally {
    lock.releaseLock();
  }
}

function apiUserReset_(req, user) {
  const u = rows_(S.USERS).find(x => x.username === req.username);
  if (!u) throw err_('المستخدم غير موجود');
  if (user.role !== 'admin' && (u.role !== 'nurse' || !branchAllowed_(user, u.branch))) throw err_('لا يمكن إعادة تعيين هذا الحساب', 'FORBIDDEN');
  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  setCells_(S.USERS, u._row, { pass_hash: hash_(temp, salt), salt: salt, must_change: 'yes' });
  log_(user.username, 'user_reset', u.username);
  return { username: u.username, tempPassword: temp };
}

function apiClinicSave_(req, user) {
  const p = req.clinic || {};
  if (!BRANCHES[p.branch]) throw err_('اختر الفرع');
  const name = clean_(p.name, 80);
  if (!name) throw err_('أدخل اسم العيادة');
  const list = rows_(S.CLINICS);
  const ex = list.find(c => c.clinic_id === p.clinic_id);
  if (list.some(c => c.branch === p.branch && normText_(c.name) === normText_(name) && c.clinic_id !== (ex && ex.clinic_id))) throw err_('يوجد قسم بنفس الاسم في هذا الفرع');
  const row = { name: name, branch: p.branch, type: clean_(p.type, 30) || 'dental',
                has_fridge: p.has_fridge ? 'yes' : 'no', status: p.status === 'inactive' ? 'inactive' : 'active' };
  if (ex) setCells_(S.CLINICS, ex._row, row);
  else {
    const id = (p.branch === 'BURIDAH' ? 'BUR-' : 'ONZ-') + clean_(p.code || name, 20).toUpperCase().replace(/\s+/g, '');
    if (list.some(c => c.clinic_id === id)) throw err_('رمز العيادة مستخدم');
    appendObjects_(S.CLINICS, [Object.assign({ clinic_id: id }, row)]);
  }
  log_(user.username, 'clinic_save', p.clinic_id || name);
  return { clinics: clinics_() };
}

/* ════════════════════════════ SETUP (شغّلها من المحرر) ════════════════════════════ */

/**
 * شغّلها مرة واحدة: تنشئ الأوراق والإعدادات والعيادات وحسابات الإدارة.
 * كلمات المرور المؤقتة تظهر في ورقة Temp_Passwords — وزّعها ثم احذف الورقة.
 */
function setup() {
  Object.keys(HEADERS).forEach(name => { if (name !== S.TEMP) sh_(name); });
  const settings = sh_(S.SETTINGS);
  const have = rows_(S.SETTINGS).map(r => r.key);
  const missing = DEFAULT_SETTINGS.filter(s => have.indexOf(s[0]) < 0);
  if (missing.length) settings.getRange(settings.getLastRow() + 1, 1, missing.length, 3).setValues(missing);

  if (!rows_(S.CLINICS).length) {
    sh_(S.CLINICS).getRange(2, 1, DEFAULT_CLINICS.length, 6).setValues(DEFAULT_CLINICS);
  }
  const staff = [
    ['admin', 'مدير النظام', 'admin', 'ALL'],
    ['quality', 'إدارة الجودة', 'quality', 'ALL'],
    ['hr', 'الموارد البشرية', 'hr', 'ALL'],
    ['supply', 'التموين', 'supply', 'ALL'],
  ];
  const users = rows_(S.USERS);
  const created = [];
  staff.forEach(s => {
    if (users.some(u => u.username === s[0])) return;
    created.push(newUserRow_({ username: s[0], name: s[1], role: s[2], branch: s[3] }));
  });
  if (created.length) {
    appendObjects_(S.USERS, created.map(c => c.row));
    writeTemp_(created);
  }
  SpreadsheetApp.getActive().toast('تم التجهيز. راجع ورقة Temp_Passwords', APP.NAME, 8);
}

/**
 * ينقل ردود Google Form (ورقة «ردود النموذج 1» في نفس الشيت) إلى النظام:
 * يوحّد الأسماء والعيادات، ينشئ حسابات الممرضات من الإيميلات، ويحوّل الإجابات إلى تقارير ومشاكل.
 * آمن للتكرار: الصفوف المنقولة سابقاً لا تُكرر، فيمكن تشغيله أكثر من مرة خلال الفترة الانتقالية.
 */
function readFormSheet_(cfg) {
  const srcId = (String(cfg.FORM_SOURCE || '').match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || String(cfg.FORM_SOURCE || '').trim();
  const ss = srcId ? SpreadsheetApp.openById(srcId) : ss_();
  const want = String(cfg.FORM_TAB || '').trim().toLowerCase();
  const isFormTab = sh => {
    const first = String(sh.getRange(1, 1).getValue()).trim();
    return sh.getName().trim().toLowerCase() === want || /^(طابع زمني|timestamp)$/i.test(first);
  };
  const src = ss.getSheets().find(isFormTab);
  if (!src) {
    const tabs = ss.getSheets().map(sh => '«' + sh.getName() + '»').join('، ');
    throw new Error(srcId
      ? 'فتحت الشيت المربوط (' + ss.getName() + ') ولم أجد فيه ورقة ردود النموذج. الأوراق الموجودة: ' + tabs + '. اكتب اسم ورقة الردود بالضبط في Settings ← FORM_TAB.'
      : 'هذا الشيت (' + ss.getName() + ') ليس فيه ورقة ردود النموذج. الأوراق الموجودة: ' + tabs + '. ضع رابط الشيت الأساسي الذي فيه ردود النموذج في Settings ← FORM_SOURCE ثم شغّل الدالة مرة أخرى.');
  }
  const values = src.getDataRange().getValues();
  const h = values.shift().map(x => String(x).toLowerCase());
  // بعض الطوابع الزمنية مكتوبة يدوياً كنص — نحولها لتاريخ
  values.forEach(v => { v[0] = parseTimestamp_(v[0]); });
  return { values: values, h: h, sheetName: src.getName() };
}

function importFormResponses() {
  const cfg = settings_();
  const form = readFormSheet_(cfg), values = form.values, h = form.h;
  const col = (re, from) => h.findIndex((x, i) => i >= (from || 0) && re.test(x));
  const C = {
    ts: 0, name: col(/name/), clinic: col(/clinic number/), expChecked: col(/expiration date of the drugs/),
    earliest: col(/earliest expiration/), steril: col(/sterilization/), fridge: col(/refrigerator/),
    card: col(/employee cards/), clean: col(/cleanliness/), oldTools: col(/what tools are missing during/),
    notes: col(/^notes/), branch: col(/barnch|branch/), email: col(/البريد|email/),
    missingYN: h.findIndex(x => /is there any missing tools\s*$/.test(x.trim())),
    toolsText: col(/explain why and how/),
  };

  // الحسابات الموجودة (إن وُجدت) تُربط بالإيميل أو الاسم
  const byEmail = {}, byName = {};
  rows_(S.USERS).filter(u => u.role === 'nurse').forEach(u => {
    if (u.email) byEmail[u.email] = u;
    byName[normText_(u.name)] = u;
    // عمود aliases: أسماء أو إيميلات أخرى لنفس الممرضة (مفصولة بفاصلة)
    splitList_(u.aliases).forEach(a => { if (/@/.test(a)) byEmail[a.toLowerCase()] = u; else byName[normText_(a)] = u; });
  });

  // توحيد الهوية: نربط كل اسم بكل إيميل ظهر معه (union-find)، فالممرضة التي غيّرت
  // إيميلها أو كتبت اسمها بعدة أشكال تصبح شخصاً واحداً
  const parent = {};
  const find = x => { while (parent[x] && parent[x] !== x) x = parent[x] = parent[parent[x]] || parent[x]; return x; };
  const union = (x, y) => { parent[x] = parent[x] || x; parent[y] = parent[y] || y; const a = find(x), b = find(y); if (a !== b) parent[b] = a; };
  const keysOf = v => {
    const k = [];
    const email = String(v[C.email] || '').trim().toLowerCase();
    const nk = normText_(v[C.name]);
    if (email) k.push('e:' + email);
    if (nk) k.push('n:' + nk);
    return k;
  };
  // الاسم يربط بإيميل واحد فقط: الأكثر استخداماً معه. فلو كتبت ممرضتان نفس الاسم القصير (Maryam)
  // بإيميلين مختلفين، لا يندمج حساباهما بسبب الاسم
  // (إيميل ثانوي يُربط بالاسم إلا إذا كان من فرع آخر: ممرضة أخرى بنفس الاسم القصير)
  const nameEmails = {}, emailBranch = {};
  const brOf = v => { const b = String(v[C.branch] || '').toUpperCase(); return b.indexOf('ONIZAH') >= 0 ? 'ONIZAH' : b.indexOf('BURIDAH') >= 0 ? 'BURIDAH' : ''; };
  values.forEach(v => {
    const k = keysOf(v);
    if (!k.length || k[0].indexOf('e:') !== 0) return;
    const b = brOf(v); if (b) { const eb = emailBranch[k[0]] = emailBranch[k[0]] || {}; eb[b] = (eb[b] || 0) + 1; }
    if (k.length !== 2) return;
    const c = nameEmails[k[1]] = nameEmails[k[1]] || {}; c[k[0]] = (c[k[0]] || 0) + 1;
  });
  const mainBranch = e => { const c = emailBranch[e] || {}; return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || ''; };
  const topEmail = {};
  Object.keys(nameEmails).forEach(n => { const c = nameEmails[n]; topEmail[n] = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; });
  const ownAccount = e => !!byEmail[e.slice(2)];
  const linkable = (e, n) => {
    const top = topEmail[n];
    if (!top || top === e) return true;
    if (ownAccount(e) && ownAccount(top)) return false;                     // لكل إيميل حسابه: شخصان
    const b1 = mainBranch(e), b2 = mainBranch(top);
    return !(b1 && b2 && b1 !== b2);                                        // فرعان مختلفان: شخصان
  };
  values.forEach(v => {
    const k = keysOf(v);
    if (k.length === 2 && !linkable(k[0], k[1])) { union(k[0], k[0]); return; }
    k.forEach(x => union(k[0], x));
  });
  Object.keys(byEmail).forEach(e => { if (parent['e:' + e]) union('e:' + e, 'e:' + e); });
  const known = {};
  const claim = (key, u) => { if (!parent[key]) return; const r = find(key); if (!known[r]) known[r] = u; };
  Object.keys(byEmail).forEach(e => claim('e:' + e, byEmail[e]));
  Object.keys(byName).forEach(n => claim('n:' + n, byName[n]));

  // كل رد في النموذج يُعرف بوقته (حتى الثانية). لو عُدّل الاسم في الشيت الأساسي بعد النقل
  // يبقى نفس التقرير ويُعاد ربطه، ولا يُنقل مرة ثانية
  const tsKey = v => 'legacy:' + Utilities.formatDate(v[C.ts], APP.TZ, 'yyyyMMddHHmmss');
  const byTs = {};
  rows_(S.REPORTS).forEach(r => {
    const m = String(r.source || '').match(/^(legacy:\d{14})/);
    if (m) (byTs[m[1]] = byTs[m[1]] || []).push(r);
  });

  // مجموعات بدون حساب معروف ⇐ ممرضات غير موجودات في القائمة: ننشئ لهن حسابات
  const recentCut = dateStr_(addDays_(new Date(), -35));
  const groups = {};
  values.forEach(v => {
    const k = keysOf(v);
    if (!(v[C.ts] instanceof Date) || !k.length) return;
    const root = find(k[0]);
    if (known[root]) return;
    if ((byTs[tsKey(v)] || []).some(r => r.username)) return;   // رد منقول ومنسوب سابقاً: تعديل اسمه لا ينشئ حساباً جديداً
    const g = groups[root] = groups[root] || { emails: {}, names: {}, last: '', branch: {}, total: 0 };
    const email = String(v[C.email] || '').trim().toLowerCase();
    const nm = String(v[C.name] || '').trim();
    if (email) g.emails[email] = (g.emails[email] || 0) + 1;
    if (nm) g.names[nm] = (g.names[nm] || 0) + 1;
    g.total++;
    const d = dateStr_(v[C.ts]); if (d > g.last) g.last = d;
    const b = String(v[C.branch] || '').toUpperCase(); if (BRANCHES[b]) g.branch[b] = (g.branch[b] || 0) + 1;
  });
  const top = o => Object.keys(o).sort((a, b) => o[b] - o[a])[0] || '';
  const createdUsers = [];
  Object.keys(groups).forEach(root => {
    const g = groups[root];
    const email = top(g.emails), name = top(g.names);
    if (!name || (g.total < 2 && !email)) return; // إدخال عابر
    const created = newUserRow_({ username: email || normText_(name), name: name, email: email, role: 'nurse',
      branch: top(g.branch) || 'BURIDAH', start_date: '', status: g.last >= recentCut ? 'active' : 'inactive',
      end_date: g.last >= recentCut ? '' : g.last });
    createdUsers.push(created);
    known[root] = created.row;
  });
  if (createdUsers.length) {
    appendObjects_(S.USERS, createdUsers.map(c => c.row));
    writeTemp_(createdUsers.filter(c => c.row.status === 'active'));
  }
  const resolveUser = v => { const k = keysOf(v); return k.length ? known[find(k[0])] : null; };

  const dupRows = [];   // نسخ مكررة من نفس الرد (من نقل سابق بعد تعديل الاسم): تُحذف
  // ربط كل صف في النموذج بتقريره المنقول: أولاً بالمفتاح نفسه، ثم بنفس الوقت (رد عُدّل اسمه).
  // قد يرد ردّان في نفس الثانية من ممرضتين، لذلك لا نعتمد على الوقت وحده إلا لما بقي
  const claimed = {}, used = new Set(), seenTs = {};
  const srcOf = (v, idx) => 'legacy:' + Utilities.formatDate(v[C.ts], APP.TZ, 'yyyyMMddHHmmss') + ':' + normText_(v[C.email] || v[C.name]).slice(0, 24);
  values.forEach((v, idx) => {
    if (!(v[C.ts] instanceof Date)) return;
    const k = tsKey(v); seenTs[k] = 1;
    const r = (byTs[k] || []).find(x => !used.has(x) && x.source === srcOf(v, idx));
    if (r) { claimed[idx] = r; used.add(r); }
  });
  values.forEach((v, idx) => {
    if (!(v[C.ts] instanceof Date) || claimed[idx]) return;
    const free = (byTs[tsKey(v)] || []).filter(x => !used.has(x));
    if (!free.length) return;
    const ou = resolveUser(v);
    const r = (ou && free.find(x => x.username === ou.username)) || free.find(x => x.username) || free[0];
    claimed[idx] = r; used.add(r);
  });
  Object.keys(seenTs).forEach(k => (byTs[k] || []).forEach(x => { if (!used.has(x)) dupRows.push(x); }));
  const unmatched = {};   // ما بقي بلا ممرضة، لعرضه في ورقة Unmatched
  const noteUnmatched = (v, when) => {
    const nm = String(v[C.name] || '').trim(), em = String(v[C.email] || '').trim().toLowerCase();
    const k = nm + '|' + em, g = unmatched[k] = unmatched[k] || { name: nm, email: em, count: 0, first: when, last: when };
    g.count++; if (when < g.first) g.first = when; if (when > g.last) g.last = when;
  };
  let relinked = 0;
  const clinics = clinics_();
  const clinicById = {};
  clinics.forEach(c => clinicById[c.clinic_id] = c);
  const newClinics = [];
  const cutoff = dateStr_(addDays_(parseDate_(currentWeek_(cfg)), -7 * (cfg.LEGACY_OPEN_WEEKS - 1)));

  const reports = [], issueCache = rows_(S.ISSUES);
  const isEmpty = t => !t || /^(no|none|nothing|nil|n\/a|-+|\.+|—|ok|non|nothing missing|nothing is missing|no missing.*|previously mentioned|as above|as mentioned.*|لا|لا يوجد|ليس)\.?$/i.test(String(t).trim());
  const yn = v => /^y/i.test(String(v).trim()) ? 'yes' : /^n/i.test(String(v).trim()) ? 'no' : '';

  values.forEach((v, idx) => {
    // المفتاح = وقت الرد + الاسم/الإيميل، فلا يتأثر بترتيب أو حذف صفوف في الشيت الأساسي
    const source = v[C.ts] instanceof Date
      ? 'legacy:' + Utilities.formatDate(v[C.ts], APP.TZ, 'yyyyMMddHHmmss') + ':' + normText_(v[C.email] || v[C.name]).slice(0, 24)
      : 'legacy:row' + (idx + 2);
    if (!(v[C.ts] instanceof Date)) return;
    const keep = claimed[idx];
    if (keep) {
      const ou = resolveUser(v);
      const upd = {};
      if (ou && ou.username !== keep.username) { upd.username = ou.username; upd.nurse_name = ou.name; relinked++; }
      if (keep.source !== source && (ou || !keep.username)) upd.source = source;
      if (Object.keys(upd).length) setCells_(S.REPORTS, keep._row, upd);
      if (!ou && !keep.username) noteUnmatched(v, keep.submitted_at);
      return;
    }
    const rawName = String(v[C.name] || '').trim();
    const u = resolveUser(v);
    if (!u) noteUnmatched(v, Utilities.formatDate(v[C.ts], APP.TZ, 'yyyy-MM-dd HH:mm'));
    let branch = String(v[C.branch] || '').toUpperCase().indexOf('ONIZAH') >= 0 && String(v[C.branch]).toUpperCase().indexOf('BURIDAH') < 0
      ? 'ONIZAH' : String(v[C.branch] || '').toUpperCase().indexOf('BURIDAH') >= 0 ? 'BURIDAH' : (u ? u.branch : '');
    if (!branch) branch = 'BURIDAH';
    const clinicId = legacyClinicId_(v[C.clinic], branch, /unaizah|onizah|عنيزة/i.test(String(v[C.clinic])));
    if (!clinicById[clinicId]) {
      const c = { clinic_id: clinicId, name: /-C(\d+)$/.test(clinicId) ? 'Old clinic ' + clinicId.match(/(\d+)$/)[1] : (String(v[C.clinic]).trim() || clinicId), branch: branch, type: 'other', has_fridge: 'no', status: 'inactive' };
      clinicById[clinicId] = c; newClinics.push(c);
    }
    const cls = classifySubmission_(v[C.ts], cfg);
    const earliest = parseLooseDate_(v[C.earliest]);
    const toolsRaw = [v[C.oldTools], v[C.toolsText]].map(x => String(x || '').trim()).filter(x => !isEmpty(x));
    const missingYN = yn(v[C.missingYN]);
    const hasTools = missingYN === 'yes' || (!missingYN && toolsRaw.length > 0);
    const r = {
      report_id: 'L' + Utilities.formatDate(v[C.ts], APP.TZ, 'yyMMddHHmmss') + (idx % 100),
      submitted_at: Utilities.formatDate(v[C.ts], APP.TZ, 'yyyy-MM-dd HH:mm:ss'),
      week_start: cls.week, timing: cls.timing,
      username: u ? u.username : '', nurse_name: u ? u.name : (rawName || 'غير معروف'),
      branch: branch, clinic_id: clinicId, clinic_name: clinicById[clinicId].name,
      expiry_checked: yn(v[C.expChecked]) || 'yes',
      earliest_expiry: earliest ? dateStr_(earliest) : '',
      expiry_item: earliest ? '' : clean_(v[C.earliest], 120),
      sterilization_ok: yn(v[C.steril]) || 'yes',
      fridge: yn(v[C.fridge]) === 'no' ? 'problem' : 'ok', fridge_temp: '',
      employee_card: yn(v[C.card]) || 'yes',
      cleanliness: yn(v[C.clean]) === 'no' ? 2 : 5,
      missing_tools: hasTools ? 'yes' : 'no',
      tools_json: JSON.stringify(hasTools ? toolsRaw.map(t => ({ item: t.slice(0, 120), qty: 1, severity: 'medium' })) : []),
      other_issue: '', notes: clean_(isEmpty(v[C.notes]) ? '' : v[C.notes], 500), issues_count: 0, source: source,
    };
    const archived = r.week_start < cutoff;
    const tools = JSON.parse(r.tools_json);
    // لا ننشئ تنبيه صلاحية للتقارير المؤرشفة
    const list = buildIssues_(Object.assign({}, r, { earliest_expiry: archived ? '' : r.earliest_expiry }), tools, cfg);
    r.issues_count = upsertIssues_(list, r, {
      cache: issueCache,
      status: archived ? 'archived' : 'open',
      resolution: archived ? 'مستورد من النظام القديم (أرشيف)' : '',
    });
    reports.push(r);
  });

  if (newClinics.length) appendObjects_(S.CLINICS, newClinics);
  if (dupRows.length) {
    // احذف النسخ المكررة وبلاغاتها التي أُنشئت معها (من الأسفل للأعلى حتى لا تتغير أرقام الصفوف)
    const dupIds = {}; dupRows.forEach(r => dupIds[r.report_id] = 1);
    const isRows = rows_(S.ISSUES).filter(i => dupIds[i.report_id]).map(i => i._row);
    isRows.sort((a, b) => b - a).forEach(r => sh_(S.ISSUES).deleteRow(r));
    dupRows.map(r => r._row).sort((a, b) => b - a).forEach(r => sh_(S.REPORTS).deleteRow(r));
    delete ROWS_CACHE_[S.ISSUES]; delete ROWS_CACHE_[S.REPORTS];
  }
  if (reports.length) appendObjects_(S.REPORTS, reports);

  // تاريخ بداية المسؤولية = أول تقرير للممرضة (إذا كان فارغاً أو أحدث من أول تقرير)
  const first = {};
  rows_(S.REPORTS).forEach(r => { if (r.username && (!first[r.username] || r.week_start < first[r.username])) first[r.username] = r.week_start; });
  rows_(S.USERS).forEach(u => {
    const f = first[u.username];
    if (u.role === 'nurse' && f && (!u.start_date || dateStr_(parseDate_(u.start_date)) > f)) setCell_(S.USERS, u._row, 'start_date', f);
  });
  // ورقة Unmatched: ردود لم تُنسب لأي ممرضة. أضف الاسم/الإيميل في عمود aliases للحساب الصحيح ثم أعد تشغيل الاستيراد
  const um = Object.keys(unmatched).map(k => unmatched[k]).sort((a, b) => b.count - a.count);
  const db = ss_();
  let ush = db.getSheetByName('Unmatched');
  if (um.length) {
    if (!ush) ush = db.insertSheet('Unmatched');
    ush.clearContents();
    const rowsOut = [['الاسم في النموذج', 'الإيميل في النموذج', 'عدد الردود', 'أول رد', 'آخر رد', 'ماذا أفعل']]
      .concat(um.map(g => [g.name || '(بدون اسم)', g.email || '(بدون إيميل)', g.count, g.first, g.last,
        'اكتب الاسم أو الإيميل في عمود aliases للممرضة الصحيحة في Users، ثم شغّل importFormResponses']));
    ush.getRange(1, 1, rowsOut.length, rowsOut[0].length).setValues(rowsOut);
  } else if (ush) db.deleteSheet(ush);
  const unCount = um.reduce((x, g) => x + g.count, 0);
  bumpDataVersion_();
  SpreadsheetApp.getActive().toast('تم نقل ' + reports.length + ' تقرير، وإنشاء ' + createdUsers.length + ' حساب ممرضة' +
    (relinked ? '، وربط ' + relinked + ' تقرير قديم بصاحبته' : '') +
    (dupRows.length ? '، وحذف ' + dupRows.length + ' نسخة مكررة' : '') +
    (unCount ? '. يوجد ' + unCount + ' رد بلا ممرضة: راجع ورقة Unmatched' : ''), APP.NAME, 12);
}


/**
 * تدقيق: يقارن كل رد في الشيت الأساسي بما في النظام، ويكتب ورقتين للمراجعة اليدوية:
 *   Audit       لكل ممرضة: عدد ردودها في النموذج، عدد تقاريرها في النظام، الإيميلات والأسماء والفروع التي ظهرت، وتنبيهات
 *   Audit_Rows  كل رد في النموذج: الوقت، الاسم والإيميل كما كُتبا، ولمن نُسب في النظام
 * لا يغيّر أي بيانات. شغّله بعد importFormResponses وقبل إصدار أي إشعار.
 */
function auditReports() {
  const cfg = settings_();
  const form = readFormSheet_(cfg), values = form.values, h = form.h;
  const col = re => h.findIndex(x => re.test(x));
  const C = { name: col(/name/), email: col(/البريد|email/), branch: col(/barnch|branch/), clinic: col(/clinic number/) };
  const users = rows_(S.USERS);
  const byUser = {}; users.forEach(u => byUser[u.username] = u);
  const reports = rows_(S.REPORTS);
  const legacyByTs = {};
  reports.forEach(r => { const m = String(r.source || '').match(/^(legacy:\d{14})/); if (m) (legacyByTs[m[1]] = legacyByTs[m[1]] || []).push(r); });
  const used = new Set();
  const rowsOut = [['وقت الرد', 'الاسم في النموذج', 'الإيميل في النموذج', 'الفرع في النموذج', 'العيادة في النموذج', '← نُسب في النظام إلى', 'إيميل الحساب', 'أسبوع السبت', 'التوقيت', 'ملاحظة']];
  const per = {};   // username → ملخص
  const P = u => per[u] = per[u] || { form: 0, emails: {}, names: {}, branches: {} };
  let missing = 0, orphan = 0;
  values.forEach(v => {
    if (!(v[0] instanceof Date)) return;
    const ts = 'legacy:' + Utilities.formatDate(v[0], APP.TZ, 'yyyyMMddHHmmss');
    const cand = (legacyByTs[ts] || []).filter(r => !used.has(r));
    const em = String(v[C.email] || '').trim().toLowerCase(), nm = String(v[C.name] || '').trim(), brn = String(v[C.branch] || '').trim();
    // عند ردّين في نفس الثانية نختار المطابق للإيميل/الاسم
    const key = normText_(em || nm).slice(0, 24);
    const r = cand.find(x => String(x.source).split(':')[2] === key) || cand[0];
    let note = '';
    if (!r) { missing++; note = '✗ غير موجود في النظام: شغّل importFormResponses'; }
    else {
      used.add(r);
      if (!r.username) { orphan++; note = '✗ بلا ممرضة: أضف الاسم/الإيميل في aliases أو ورقة Merges'; }
      else {
        const p = P(r.username); p.form++;
        if (em) p.emails[em] = (p.emails[em] || 0) + 1;
        if (nm) p.names[nm] = (p.names[nm] || 0) + 1;
        if (brn) p.branches[brn.toUpperCase()] = (p.branches[brn.toUpperCase()] || 0) + 1;
      }
    }
    const u = r && byUser[r.username];
    rowsOut.push([Utilities.formatDate(v[0], APP.TZ, 'yyyy-MM-dd HH:mm:ss'), nm, em, brn, String(v[C.clinic] || ''),
      u ? u.name : (r ? '(بلا ممرضة)' : '—'), u ? (u.email || u.username) : '', r ? r.week_start : '', r ? r.timing : '', note]);
  });
  const extraLegacy = Object.keys(legacyByTs).reduce((n, k) => n + legacyByTs[k].filter(r => !used.has(r)).length, 0);

  const out = [['الممرضة', 'الحساب', 'الحالة', 'الفرع', 'ردود النموذج', 'تقارير من المنصة', 'الإجمالي في النظام', 'الإيميلات في النموذج', 'الأسماء في النموذج', 'الفروع في النموذج', 'تنبيه']];
  users.filter(u => u.role === 'nurse').forEach(u => {
    const p = per[u.username] || { form: 0, emails: {}, names: {}, branches: {} };
    const mine = reports.filter(r => r.username === u.username);
    const platform = mine.filter(r => String(r.source || '').indexOf('legacy:') !== 0).length;
    const fmt = o => Object.keys(o).map(k => k + ' (' + o[k] + ')').join('، ');
    const flags = [];
    if (Object.keys(p.emails).length > 1) flags.push('أكثر من إيميل: تأكد أنها نفس الممرضة');
    if (Object.keys(p.branches).length > 1) flags.push('ردود من أكثر من فرع');
    const first = normText_(String(u.name).split(/\s+/)[0]);
    const odd = Object.keys(p.names).filter(n => normText_(n).indexOf(first) < 0 && first.indexOf(normText_(n).slice(0, 4)) < 0);
    if (odd.length) flags.push('أسماء لا تشبه اسم الحساب: ' + odd.join('، '));
    if (mine.length !== p.form + platform) flags.push('عدد غير متطابق');
    out.push([u.name, u.email || u.username, u.status === 'active' ? 'على رأس العمل' : 'ترك العمل', br_(u.branch), p.form, platform, mine.length,
      fmt(p.emails), fmt(p.names), fmt(p.branches), flags.join(' · ') || '✓']);
  });
  const db = ss_();
  const write = (name, data) => {
    let sh = db.getSheetByName(name);
    if (!sh) sh = db.insertSheet(name);
    sh.clearContents();
    sh.getRange(1, 1, data.length, data[0].length).setNumberFormat('@').setValues(data.map(r => r.map(c => c == null ? '' : String(c))));
    sh.setFrozenRows(1);
  };
  write('Audit', out);
  write('Audit_Rows', rowsOut);
  const formRows = rowsOut.length - 1;
  const msg = 'التدقيق: ' + formRows + ' رد في النموذج · ' + (formRows - missing - orphan) + ' منسوب لممرضة · ' + orphan + ' بلا ممرضة · ' + missing + ' غير منقول'
    + (extraLegacy ? ' · ' + extraLegacy + ' تقرير منقول لم يعد موجوداً في النموذج' : '') + '. راجع ورقتي Audit وAudit_Rows';
  SpreadsheetApp.getActive().toast(msg, APP.NAME, 15);
  return { formRows: formRows, missing: missing, orphan: orphan, extraLegacy: extraLegacy };
}
function br_(b) { return BRANCHES[b] || b || ''; }

/**
 * تغيير اسم ممرضة في كل مكان: الحساب، وتقاريرها وبلاغاتها السابقة. الاسم القديم يُحفظ في aliases
 * حتى تبقى ردود النموذج المكتوبة به منسوبة لها.
 */
/** حساب آخر يحمل نفس الاسم أو اسماً بديلاً مطابقاً (تغيير الاسم إليه سيخلط ردود النموذج بين الحسابين) */
function nameClash_(u, newName, nurses) {
  const q = normText_(newName);
  return nurses.find(x => x.username !== u.username && [x.name].concat(splitList_(x.aliases)).some(k => normText_(k) === q)) || null;
}

function renameNurse_(u, newName) {
  const name = clean_(newName, 80);
  if (!name || name === u.name) return false;
  const al = splitList_(u.aliases);
  if (u.name && !al.some(a => normText_(a) === normText_(u.name))) al.push(u.name);
  setCells_(S.USERS, u._row, { name: name, aliases: al.join(', ') });
  [S.REPORTS, S.ISSUES].forEach(sn => {
    const sheet = sh_(sn), last = sheet.getLastRow();
    if (last < 2) return;
    const hd = HEADERS[sn], ui = hd.indexOf('username'), ni = hd.indexOf('nurse_name');
    const vals = sheet.getRange(2, 1, last - 1, hd.length).getValues();
    let changed = false;
    vals.forEach(v => { if (String(v[ui]).trim() === u.username && v[ni] !== name) { v[ni] = name; changed = true; } });
    if (changed) sheet.getRange(2, ni + 1, vals.length, 1).setValues(vals.map(v => [v[ni]]));
    delete ROWS_CACHE_[sn];
  });
  bumpDataVersion_();
  return true;
}

/**
 * تعديل أسماء الممرضات دفعة واحدة. أنشئ ورقة Names بعمودين: account | name
 *   account  إيميل الحساب أو اسم الدخول أو الاسم الحالي
 *   name     الاسم الصحيح كما تريده أن يظهر
 * previewNames يكتب في عمود result ما سيتغير، وapplyNames يطبّق (ويحدّث الاسم في التقارير السابقة).
 */
function previewNames() { return processNames_(true); }
function applyNames() { return processNames_(false); }
function processNames_(dryRun) {
  const sh = ss_().getSheetByName('Names');
  if (!sh) throw new Error('أنشئ ورقة باسم Names وفيها العمودان: account | name');
  const data = sh.getDataRange().getValues();
  const head = data.shift().map(x => String(x).trim().toLowerCase());
  const ca = head.indexOf('account'), cn = head.indexOf('name');
  if (ca < 0 || cn < 0) throw new Error('العمودان account وname مطلوبان في الصف الأول');
  let rc = head.indexOf('result'); if (rc < 0) { rc = head.length; sh.getRange(1, rc + 1).setValue('result'); }
  const nurses = rows_(S.USERS).filter(u => u.role === 'nurse');
  let ok = 0, bad = 0;
  data.forEach((row, i) => {
    const acc = String(row[ca] || '').trim(), nm = clean_(row[cn], 80);
    if (!acc && !nm) return;
    const say = m => sh.getRange(i + 2, rc + 1).setValue(m);
    const hits = findNurseExact_(acc, nurses);
    if (hits.length !== 1) { bad++; return say(hits.length ? '✗ يطابق أكثر من حساب: اكتب الإيميل' : '✗ لا يوجد حساب بهذا الإيميل/الاسم'); }
    const u = hits[0];
    if (!nm) { bad++; return say('✗ اكتب الاسم الجديد'); }
    if (nm === u.name) { ok++; return say('بدون تغيير'); }
    const clash = nameClash_(u, nm, nurses);
    if (clash) { bad++; return say('✗ الاسم «' + nm + '» مستخدم لحساب آخر (' + clash.name + ' · ' + (clash.email || clash.username) + '). إن كانتا نفس الممرضة ادمجهما أولاً من ورقة Merges'); }
    if (!dryRun) renameNurse_(rows_(S.USERS).find(x => x.username === u.username), nm);
    ok++; say((dryRun ? 'سيتغير: ' : 'تم: ') + u.name + ' ← ' + nm);
  });
  SpreadsheetApp.getActive().toast((dryRun ? 'معاينة: ' : 'تم: ') + ok + ' · يحتاج مراجعة: ' + bad, APP.NAME, 10);
  return { ok: ok, failed: bad };
}

/**
 * يعيد بناء التقارير المنقولة من النموذج من الصفر.
 * استخدمها بعد دمج حسابات مكررة: اكتب الاسم أو الإيميل المكرر في عمود aliases للحساب الصحيح،
 * احذف صف الحساب المكرر من Users، ثم شغّل هذه الدالة.
 * لا تمس التقارير المرفوعة من المنصة الجديدة.
 */
function rebuildFromForm() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const legacy = r => String(r.source || '').indexOf('legacy:') === 0;
    const keepReports = rows_(S.REPORTS).filter(r => !legacy(r));
    const keepIds = {};
    keepReports.forEach(r => keepIds[r.report_id] = 1);
    const keepIssues = rows_(S.ISSUES).filter(i => keepIds[i.report_id]);
    [S.REPORTS, S.ISSUES].forEach(n => { const sh = sh_(n); if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[n].length).clearContent(); delete ROWS_CACHE_[n]; });
    if (keepReports.length) appendObjects_(S.REPORTS, keepReports);
    if (keepIssues.length) appendObjects_(S.ISSUES, keepIssues);
  } finally {
    lock.releaseLock();
  }
  importFormResponses();
}

function parseTimestamp_(v) {
  if (v instanceof Date) return v;
  const m = String(v || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\D*?(م|ص|pm|am)?\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/i);
  if (!m) return v;
  let h = +m[1];
  const pm = /م|pm/i.test(m[4] || ''), am = /ص|am/i.test(m[4] || '');
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (!pm && !am && h < 7) h += 12; // النموذج يُعبّأ نهاراً: 1:48 تعني 13:48
  return new Date(+m[5], +m[6] - 1, +m[7], h, +m[2], +(m[3] || 0));
}

function legacyClinicId_(raw, branch, forceOnizah) {
  const t = String(raw || '').toLowerCase();
  const pre = (forceOnizah || branch === 'ONIZAH') ? 'ONZ-' : 'BUR-';
  // أسماء قديمة (غرفة التشقير/التبييض أو «derma» فقط) تُنسب إلى Derma CLINIC
  const rules = [[/clarity/, 'CLARITY'], [/gent/, 'GENTLE'], [/hydra|هيدرا/, 'HYDRAFACIAL'], [/steril|تعقيم/, 'STERIL'],
                 [/bleach|تشقير|تبييض|derma/, 'DERMA']];
  for (let i = 0; i < rules.length; i++) if (rules[i][0].test(t)) return pre + rules[i][1];
  const m = t.replace(/o(?=\d)/g, '0').match(/\d+/);
  if (m && pre === 'BUR-' && Number(m[0]) === 14) return 'BUR-DERMA';   // «14» في بريدة كانت خطأ: هي Derma CLINIC
  return m ? pre + 'C' + Number(m[0]) : pre + 'OTHER';
}

/* ════════════════════════════ OUTPUT SHAPES ════════════════════════════ */

function reportOut_(r) {
  let tools = [];
  try { tools = JSON.parse(r.tools_json || '[]'); } catch (e) {}
  return {
    report_id: r.report_id, submitted_at: r.submitted_at, week_start: r.week_start, timing: r.timing,
    nurse_name: r.nurse_name, username: r.username, branch: r.branch, clinic_id: r.clinic_id, clinic_name: r.clinic_name,
    expiry_checked: r.expiry_checked, earliest_expiry: r.earliest_expiry, expiry_item: r.expiry_item,
    sterilization_ok: r.sterilization_ok, fridge: r.fridge, fridge_temp: r.fridge_temp,
    employee_card: r.employee_card, cleanliness: Number(r.cleanliness) || null, missing_tools: r.missing_tools,
    tools: tools, other_issue: r.other_issue, notes: r.notes, issues_count: Number(r.issues_count) || 0,
  };
}

/** هل بلّغت هذه الممرضة عن المشكلة (بنفسها)؟ */
function reportedBy_(i, username) {
  return i.username === username || splitList_(i.reporters).indexOf(username) >= 0;
}

function issueOut_(i) {
  return {
    issue_id: i.issue_id, report_id: i.report_id, created_at: i.created_at, week_start: i.week_start,
    branch: i.branch, clinic_id: i.clinic_id, clinic_name: i.clinic_name, nurse_name: i.nurse_name,
    category: i.category, categoryLabel: (CATEGORIES[i.category] || {}).label || i.category,
    item: i.item, qty: i.qty, severity: i.severity, description: i.description, department: i.department,
    status: i.status, occurrences: Number(i.occurrences) || 1, last_seen: i.last_seen,
    assigned_to: i.assigned_to, updated_at: i.updated_at, updated_by: i.updated_by,
    resolved_at: i.resolved_at, resolution: i.resolution,
    ageDays: Math.max(0, daysBetween_(parseDateTime_(i.created_at), new Date())),
  };
}

/* ════════════════════════════ SHEET HELPERS ════════════════════════════ */

/* ───────── السرعة: فتح الشيت مرة واحدة لكل طلب، وحفظ نتائج الصفحات ───────── */
let SS_ = null;
const SHEETS_ = {};
function ss_() {
  if (SS_) return SS_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return (SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet());
}

/** رقم نسخة البيانات: يتغير مع كل تعديل، فتُهمل النتائج المحفوظة القديمة تلقائياً */
let DV_ = null;
function dataVersion_() {
  if (DV_) return DV_;
  const c = CacheService.getScriptCache();
  DV_ = c.get('dv');
  if (!DV_) { DV_ = String(Date.now()); c.put('dv', DV_, 21600); }
  return DV_;
}
function bumpDataVersion_() {
  DV_ = String(Date.now()) + Math.floor(Math.random() * 1000);
  try { CacheService.getScriptCache().put('dv', DV_, 21600); } catch (e) { /* لا شيء */ }
}
/** أي تعديل يدوي على الشيت يُبطل النتائج المحفوظة (يعمل حين يكون السكربت مرتبطاً بالشيت) */
function onEdit() { bumpDataVersion_(); }

function respKey_(req, user) {
  const p = {}; Object.keys(req).sort().forEach(k => { if (k !== 'token') p[k] = req[k]; });
  const raw = user.username + '|' + JSON.stringify(p) + '|' + Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMddHH');
  return 'r_' + dataVersion_() + '_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw));
}
/** تخزين مضغوط ومقسّم (حد CacheService ‏100KB لكل مفتاح) */
function cachePut_(key, str) {
  try {
    const z = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(str, 'application/json')).getBytes());
    const size = 90000, n = Math.ceil(z.length / size);
    if (n > 20) return;
    const parts = { };
    for (let i = 0; i < n; i++) parts[key + '_' + i] = z.slice(i * size, (i + 1) * size);
    parts[key] = String(n);
    CacheService.getScriptCache().putAll(parts, 600);
  } catch (e) { /* التخزين اختياري */ }
}
function cacheGet_(key) {
  try {
    const c = CacheService.getScriptCache();
    const n = Number(c.get(key) || 0);
    if (!n) return null;
    const keys = []; for (let i = 0; i < n; i++) keys.push(key + '_' + i);
    const got = c.getAll(keys);
    let z = '';
    for (let i = 0; i < n; i++) { if (got[keys[i]] == null) return null; z += got[keys[i]]; }
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(z), 'application/x-gzip')).getDataAsString();
  } catch (e) { return null; }
}

function sh_(name) {
  if (SHEETS_[name]) return SHEETS_[name];
  const ss = ss_();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    const h = HEADERS[name];
    s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#0f3d3e').setFontColor('#ffffff');
    s.setFrozenRows(1);
    // نص عادي لمنع Sheets من تحويل التواريخ والأرقام تلقائياً
    s.getRange(1, 1, s.getMaxRows(), h.length).setNumberFormat('@');
  }
  return (SHEETS_[name] = s);
}

const ROWS_CACHE_ = {};
function rows_(name) {
  if (ROWS_CACHE_[name]) return ROWS_CACHE_[name];
  const s = sh_(name);
  const last = s.getLastRow();
  const h = HEADERS[name];
  if (last < 2) return (ROWS_CACHE_[name] = []);
  const values = s.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  values.forEach((r, i) => {
    if (!r.some(c => c !== '' && c !== null)) return;
    const o = { _row: i + 2 };
    h.forEach((k, j) => { o[k] = r[j] instanceof Date ? cellDate_(r[j]) : (typeof r[j] === 'string' ? r[j].trim() : r[j]); });
    out.push(o);
  });
  return (ROWS_CACHE_[name] = out);
}

function appendObjects_(name, objs, sheet) {
  const s = sheet || sh_(name);
  const h = HEADERS[name];
  const values = objs.map(o => h.map(k => o[k] == null ? '' : o[k]));
  const start = s.getLastRow() + 1;
  if (start + values.length > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), values.length + 100);
  const range = s.getRange(start, 1, values.length, h.length);
  range.setNumberFormat('@');
  range.setValues(values.map(r => r.map(c => typeof c === 'number' ? String(c) : c)));
  delete ROWS_CACHE_[name];
  if (name !== S.LOG) bumpDataVersion_();
}

function setCell_(name, row, key, value) {
  const obj = {}; obj[key] = value; setCells_(name, row, obj);
}

function setCells_(name, row, obj) {
  const s = sh_(name);
  const h = HEADERS[name];
  Object.keys(obj).forEach(k => {
    const c = h.indexOf(k);
    if (c >= 0) s.getRange(row, c + 1).setNumberFormat('@').setValue(obj[k] == null ? '' : String(obj[k]));
  });
  delete ROWS_CACHE_[name];
  if (!(name === S.USERS && Object.keys(obj).join() === 'last_login')) bumpDataVersion_();   // تسجيل الدخول لا يُبطل الصفحات المحفوظة
}

function settings_() {
  const out = {};
  DEFAULT_SETTINGS.forEach(s => out[s[0]] = s[1]);
  rows_(S.SETTINGS).forEach(r => {
    if (r.key === '' || r.value === '' || r.value == null) return;
    out[r.key] = typeof out[r.key] === 'number' ? Number(r.value) : String(r.value).trim();
  });
  return out;
}

function clinics_() {
  return rows_(S.CLINICS).map(c => ({ clinic_id: c.clinic_id, name: c.name, branch: c.branch, type: c.type,
                                      has_fridge: c.has_fridge, status: c.status || 'active' }));
}

function log_(user, action, details) {
  try { appendObjects_(S.LOG, [{ at: nowStr_(), user: user, action: action, details: details }]); } catch (e) {}
}

function newUserRow_(o) {
  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  return {
    temp: temp,
    row: {
      username: o.username, name: o.name, email: o.email || '', role: o.role, branch: o.branch,
      clinics: o.clinics || '', status: o.status || 'active', end_date: o.end_date || '', start_date: o.start_date != null ? o.start_date : dateStr_(new Date()),
      pass_hash: hash_(temp, salt), salt: salt, must_change: 'yes', created_at: nowStr_(), last_login: '',
    },
  };
}

function writeTemp_(created) {
  if (!created.length) return;
  const s = ss_().getSheetByName(S.TEMP) || sh_(S.TEMP);
  appendObjects_(S.TEMP, created.map(c => ({ name: c.row.name, username: c.row.username, role: c.row.role,
                                             temp_password: c.temp, created_at: nowStr_() })), s);
}

function tempPassword_() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/* ════════════════════════════ GENERIC HELPERS ════════════════════════════ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function err_(msg, code) {
  const e = new Error(msg);
  e.userMessage = msg;
  e.code = code || 'BAD_REQUEST';
  return e;
}

function nowStr_() { return Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd HH:mm:ss'); }

function dateStr_(d) { return d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd') : ''; }

function cellDate_(d) {
  const t = Utilities.formatDate(d, APP.TZ, 'HH:mm:ss');
  return t === '00:00:00' ? dateStr_(d) : Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd HH:mm:ss');
}

/** يبني تاريخاً محلياً (منتصف الليل بتوقيت الرياض) — يتجنب انزياح المنطقة الزمنية */
function parseDate_(v) {
  if (v instanceof Date) return isNaN(v) ? null : startOfDay_(v);
  const m = String(v || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function parseDateTime_(v) {
  if (v instanceof Date) return v;
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date();
}

function startOfDay_(d) {
  const p = Utilities.formatDate(d, APP.TZ, 'yyyy-M-d').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function addDays_(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

function daysBetween_(a, b) {
  return Math.round((startOfDay_(b).getTime() - startOfDay_(a).getTime()) / 86400000);
}

function weekOf_(dateStr, cfg) {
  const d = parseDate_(dateStr);
  return d ? classifySubmission_(d, cfg).week : '';
}

/** يحاول قراءة تواريخ النموذج القديم المكتوبة نصاً حراً */
function parseLooseDate_(v) {
  const d = parseLooseDateRaw_(v);
  return d && d.getFullYear() >= 2020 && d.getFullYear() <= 2040 ? d : null;
}

function parseLooseDateRaw_(v) {
  if (v instanceof Date) return isNaN(v) ? null : startOfDay_(v);
  const t = String(v || '').toLowerCase();
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m;
  if ((m = t.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = t.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/))) return new Date(+m[3], +m[2] - 1, +m[1]);
  if ((m = t.match(/(\d{1,2})?\s*,?\s*([a-z]{3})[a-z]*\.?\s*,?\s*(\d{1,2})?\s*,?\s*(\d{4})/))) {
    const mon = months[m[2]];
    if (mon) return new Date(+m[4], mon - 1, +(m[1] || m[3] || 1));
  }
  if ((m = t.match(/(\d{1,2})\s*[\/\-_.,]\s*(\d{4})/))) { if (+m[1] >= 1 && +m[1] <= 12) return new Date(+m[2], +m[1] - 1, 1); }
  return null;
}

function bestTiming_(rs) {
  if (!rs.length) return 'missing';
  return rs.reduce((best, r) => (TIMING_RANK[r.timing] || 0) > (TIMING_RANK[best] || 0) ? r.timing : best, 'very_late');
}

function sevRank_(s) { return s === 'high' ? 3 : s === 'medium' ? 2 : 1; }
function splitList_(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function unique_(a) { return a.filter((x, i) => a.indexOf(x) === i); }
function normText_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ''); }
function clean_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 200); }
