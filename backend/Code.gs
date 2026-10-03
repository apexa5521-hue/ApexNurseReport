/**
 * ApexCare — نظام التقرير الأسبوعي للتمريض
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
  NAME: 'ApexCare Nursing',
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
};

const HEADERS = {
  Users: ['username', 'name', 'email', 'role', 'branch', 'clinics', 'status', 'start_date',
          'pass_hash', 'salt', 'must_change', 'created_at', 'last_login', 'aliases', 'end_date', 'last_reminder'],
  Clinics: ['clinic_id', 'name', 'branch', 'type', 'has_fridge', 'status'],
  Reports: ['report_id', 'submitted_at', 'week_start', 'timing', 'username', 'nurse_name', 'branch',
            'clinic_id', 'clinic_name', 'expiry_checked', 'earliest_expiry', 'expiry_item',
            'sterilization_ok', 'fridge', 'fridge_temp', 'employee_card', 'cleanliness',
            'missing_tools', 'tools_json', 'other_issue', 'notes', 'issues_count', 'source'],
  Issues: ['issue_id', 'report_id', 'created_at', 'week_start', 'branch', 'clinic_id', 'clinic_name',
           'username', 'nurse_name', 'category', 'item', 'qty', 'severity', 'description',
           'department', 'status', 'occurrences', 'last_seen', 'assigned_to', 'updated_at',
           'updated_by', 'resolved_at', 'resolution'],
  Settings: ['key', 'value', 'description'],
  Audit_Log: ['at', 'user', 'action', 'details'],
  Temp_Passwords: ['name', 'username', 'role', 'temp_password', 'created_at'],
  Leaves: ['leave_id', 'username', 'from_date', 'to_date', 'cancelled', 'created_at', 'created_by'],
};

const DEFAULT_SETTINGS = [
  ['DEADLINE_WEEKDAY', 6, 'يوم التسليم: 6 = السبت (0 الأحد … 6 السبت)'],
  ['LATE_ALLOWED_DAYS', 1, 'عدد أيام السماح بعد يوم التسليم (1 = الأحد يُحسب متأخر)'],
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
  for (let i = 1; i <= 4; i++) list.push(['ONZ-C' + i, 'Dental Clinic ' + i, 'ONIZAH', 'dental', 'yes', 'active']);
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
    const data = handler.fn(req, user);
    return json_({ ok: true, data: data });
  } catch (ex) {
    const msg = ex && ex.userMessage ? ex.userMessage : 'حدث خطأ في الخادم';
    if (!(ex && ex.userMessage)) console.error(req.action, ex && ex.stack || ex);
    return json_({ ok: false, error: msg, code: ex && ex.code || 'ERR' });
  }
}

const STAFF = ['hr', 'quality', 'supply', 'admin'];

const ACTIONS = {
  login:            { fn: apiLogin_ },
  logout:           { fn: apiLogout_ },
  me:               { roles: ['*'], fn: (r, u) => ({ user: publicUser_(u) }) },
  changePassword:   { roles: ['*'], fn: apiChangePassword_ },

  'nurse.context':  { roles: ['nurse', 'admin'], fn: apiNurseContext_ },
  'nurse.submit':   { roles: ['nurse', 'admin'], fn: apiNurseSubmit_ },

  'hr.overview':    { roles: ['hr', 'admin'], fn: apiHrOverview_ },
  'hr.remind':      { roles: ['hr', 'admin'], fn: apiHrRemind_ },
  // الموارد البشرية لا ترى الإحصائيات الفنية (تعقيم، أدوية، ثلاجة…) ولا تفاصيل التقارير
  'quality.stats':  { roles: ['quality', 'admin'], fn: apiQualityStats_ },
  'reports.list':   { roles: ['quality', 'admin'], fn: apiReportsList_ },

  'issues.list':    { roles: STAFF, fn: apiIssuesList_ },
  'issues.update':  { roles: ['supply', 'quality', 'hr', 'admin'], fn: apiIssueUpdate_ },

  'users.list':     { roles: ['hr', 'admin'], fn: apiUsersList_ },
  'users.save':     { roles: ['hr', 'admin'], fn: apiUserSave_ },
  'users.reset':    { roles: ['hr', 'admin'], fn: apiUserReset_ },
  'users.setStatus': { roles: ['hr', 'admin'], fn: apiUserSetStatus_ },
  'clinics.list':   { roles: STAFF, fn: () => ({ clinics: clinics_() }) },
  'clinics.save':   { roles: ['admin', 'quality'], fn: apiClinicSave_ },
};

/* ════════════════════════════ AUTH ════════════════════════════ */

function apiLogin_(req) {
  const id = String(req.username || '').trim().toLowerCase();
  const pw = String(req.password || '');
  if (!id || !pw) throw err_('أدخل اسم المستخدم وكلمة المرور');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= APP.MAX_LOGIN_FAILS) throw err_('تم إيقاف المحاولة مؤقتاً. حاول بعد ' + APP.LOCK_MINUTES + ' دقائق');

  const u = rows_(S.USERS).find(x =>
    String(x.username).toLowerCase() === id || (x.email && String(x.email).toLowerCase() === id));

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

function apiLogout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return {};
}

function apiChangePassword_(req, user) {
  const oldPw = String(req.oldPassword || '');
  const newPw = String(req.newPassword || '');
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
  const u = rows_(S.USERS).find(x => x.username === username);
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
 * - بعدها ⇐ متأخر جداً (يُحسب لنفس الأسبوع)
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
  const clinicIds = clinics.map(c => c.clinic_id);
  const openIssues = rows_(S.ISSUES)
    .filter(i => (i.status === 'open' || i.status === 'in_progress') && clinicIds.indexOf(i.clinic_id) >= 0)
    .map(issueOut_);

  return {
    user: publicUser_(user),
    week: now.week,
    timingIfNow: now.timing,
    deadline: now.week,
    lateUntil: dateStr_(addDays_(parseDate_(now.week), cfg.LATE_ALLOWED_DAYS)),
    clinics: clinics.map(c => ({
      clinic_id: c.clinic_id, name: c.name, branch: c.branch, type: c.type, has_fridge: c.has_fridge === 'yes',
      submitted: weekAll.some(r => r.clinic_id === c.clinic_id),
      submittedBy: (weekAll.find(r => r.clinic_id === c.clinic_id) || {}).nurse_name || '',
    })),
    submittedThisWeek: thisWeek.map(reportOut_),
    history: history,
    openIssues: openIssues,
    fridgeRange: [cfg.FRIDGE_MIN, cfg.FRIDGE_MAX],
  };
}

function nurseClinics_(user) {
  const all = clinics_().filter(c => c.status === 'active');
  const assigned = splitList_(user.clinics);
  if (assigned.length) return all.filter(c => assigned.indexOf(c.clinic_id) >= 0);
  return all.filter(c => !user.branch || user.branch === 'ALL' || c.branch === user.branch);
}

function apiNurseSubmit_(req, user) {
  const cfg = settings_();
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
    const cls = classifySubmission_(when, cfg);
    const dup = rows_(S.REPORTS).find(x => x.week_start === cls.week && x.clinic_id === clinic.clinic_id);
    if (dup) throw err_('تم رفع تقرير ' + clinic.name + ' لهذا الأسبوع مسبقاً (' + dup.nurse_name + ')');

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
      last_seen: report.week_start, assigned_to: '', updated_at: report.submitted_at, updated_by: '',
      resolved_at: opts.status === 'archived' ? report.submitted_at : '', resolution: opts.resolution || '',
    };
    const prev = openMap[key(obj)];
    if (prev && obj.status !== 'archived') {
      prev.occurrences = Number(prev.occurrences || 1) + 1;
      prev.last_seen = report.week_start;
      prev.qty = obj.qty || prev.qty;
      prev.description = obj.description;
      if (sevRank_(obj.severity) > sevRank_(prev.severity)) prev.severity = obj.severity;
      if (prev._row) {
        setCells_(S.ISSUES, prev._row, { occurrences: prev.occurrences, last_seen: prev.last_seen, qty: prev.qty,
          description: prev.description, severity: prev.severity, updated_at: report.submitted_at });
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
  if (n.start_date) { const st = dateStr_(parseDate_(n.start_date)); if (st && w < weekOf_(st, cfg)) return false; }
  if (n.status !== 'active') {
    const end = n.end_date ? dateStr_(parseDate_(n.end_date)) : '';
    if (!end || w > end) return false;   // متوقفة عن العمل
  }
  return !onLeave_(leaves, w);
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
      compliance: counted.length ? Math.round(done.length / counted.length * 100) : null,
      onTimeRate: counted.length ? Math.round(onTime.length / counted.length * 100) : null,
      missedStreak: streak,
      lastSubmission: mine.reduce((m, r) => r.submitted_at > m ? r.submitted_at : m, ''),
      lastReminder: n.last_reminder || '',
    };
  });
}

function apiHrOverview_(req, user) {
  const cfg = settings_();
  const week = normalizeWeek_(req.week, cfg);
  const weeks = weeksBack_(week, Math.min(52, Math.max(4, Number(req.weeks) || 12)));
  const roster = buildRoster_(user, week, weeks, cfg);

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
    remindedToday: roster.filter(r => r.thisWeek === 'missing' && String(r.lastReminder).slice(0, 10) === today).length,
    roster: roster.sort((a, b) => (ROSTER_ORDER[a.thisWeek] - ROSTER_ORDER[b.thisWeek]) || (a.compliance == null ? 101 : a.compliance) - (b.compliance == null ? 101 : b.compliance)),
    cardIssues: cardIssues,
  };
}

function emailOf_(r) {
  const e = String(r.email || (String(r.username).indexOf('@') > 0 ? r.username : '')).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

/* ───────── تذكير الممرضات اللواتي لم يسلّمن ───────── */

function apiHrRemind_(req, user) {
  const cfg = settings_();
  const res = sendReminders_(user, currentWeek_(cfg), cfg, 'missed');
  log_(user.username, 'remind', res.sent.length + ' sent');
  return res;
}

/** يرسل بريداً لكل ممرضة نشطة لم تسلّم تقرير الأسبوع. kind: 'deadline' (صباح السبت) أو 'missed' (متابعة) */
function sendReminders_(scopeUser, week, cfg, kind) {
  const roster = buildRoster_(scopeUser, week, [week], cfg).filter(r => r.thisWeek === 'missing' && r.state === 'active');
  const withMail = roster.filter(emailOf_), noEmail = roster.filter(r => !emailOf_(r)).map(r => r.name);
  if (!withMail.length) return { sent: [], noEmail: noEmail, failed: [], week: week };
  const quota = MailApp.getRemainingDailyQuota();
  if (quota < withMail.length) throw err_('حصة البريد اليومية لا تكفي (المتبقي ' + quota + ' رسالة). حاول غداً.');

  const url = cfg.APP_URL ? String(cfg.APP_URL) : '';
  const subject = 'تذكير: التقرير الأسبوعي للعيادة | Weekly clinic report reminder';
  const line = kind === 'deadline'
    ? ['اليوم موعد رفع التقرير الأسبوعي للعيادة (السبت ' + week + ').', 'Today is the deadline for the weekly clinic report (Saturday ' + week + ').']
    : ['لم يصلنا بعد تقرير العيادة لأسبوع السبت ' + week + '. نرجو رفعه في أقرب وقت.', 'We have not received your clinic report for the week of Saturday ' + week + ' yet. Please submit it as soon as possible.'];
  const users = {};
  rows_(S.USERS).forEach(u => { users[u.username] = u; });

  const sent = [], failed = [];
  withMail.forEach(r => {
    const body = ['مرحباً ' + r.name + '،', line[0], url ? 'رابط الدخول: ' + url : '', '',
                  'Hello ' + r.name + ',', line[1], url ? 'Sign-in link: ' + url : '', '', 'ApexCare Clinics']
      .filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n');
    try {
      MailApp.sendEmail({ to: emailOf_(r), subject: subject, body: body, name: 'ApexCare Nursing' });
      sent.push(r.name);
      if (users[r.username]) setCell_(S.USERS, users[r.username]._row, 'last_reminder', nowStr_());
    } catch (e) { failed.push(r.name); }
  });
  return { sent: sent, noEmail: noEmail, failed: failed, week: week };
}

/** تذكير تلقائي (يعمل بالمشغّل الزمني، شغّل installReminderTriggers مرة واحدة لتفعيله) */
function autoReminderSaturday() { const cfg = settings_(); sendReminders_({ role: 'admin', branch: 'ALL' }, currentWeek_(cfg), cfg, 'deadline'); }
function autoReminderSunday() { const cfg = settings_(); sendReminders_({ role: 'admin', branch: 'ALL' }, currentWeek_(cfg), cfg, 'missed'); }

function installReminderTriggers() {
  const names = ['autoReminderSaturday', 'autoReminderSunday'];
  ScriptApp.getProjectTriggers().filter(t => names.indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoReminderSaturday').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(10).create();
  ScriptApp.newTrigger('autoReminderSunday').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(10).create();
  SpreadsheetApp.getActive().toast('تم تفعيل التذكير التلقائي: السبت والأحد الساعة 10 صباحاً', APP.NAME, 8);
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
  const from = req.from ? normalizeWeek_(req.from, cfg) : dateStr_(addDays_(parseDate_(to), -7 * 11));
  const branch = req.branch && req.branch !== 'ALL' ? req.branch : null;
  const inScope = b => branchAllowed_(user, b) && (!branch || b === branch);

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

  return {
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
  const from = req.from ? normalizeWeek_(req.from, cfg) : to;
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
    .filter(u => user.role === 'admin' || u.role === 'nurse')
    .filter(u => branchAllowed_(user, u.branch) || u.branch === 'ALL' && user.role === 'admin')
    .map(u => {
      const st = nurseState_(u, lm[u.username], today);
      return { username: u.username, name: u.name, email: u.email, role: u.role, branch: u.branch,
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

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const users = rows_(S.USERS);
    const existing = p.username ? users.find(u => u.username === p.username) : null;
    const clinicsStr = (Array.isArray(p.clinics) ? p.clinics : []).join(',');
    if (existing) {
      if (user.role !== 'admin' && existing.role !== 'nurse') throw err_('لا يمكن تعديل هذا الحساب', 'FORBIDDEN');
      setCells_(S.USERS, existing._row, {
        name: name, email: email, role: role, branch: branch, clinics: clinicsStr,
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
function importFormResponses() {
  const cfg = settings_();
  const srcId = (String(cfg.FORM_SOURCE || '').match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || String(cfg.FORM_SOURCE || '').trim();
  const ss = srcId ? SpreadsheetApp.openById(srcId) : ss_();
  const src = ss.getSheetByName(cfg.FORM_TAB) ||
    ss.getSheets().find(sh => /^(طابع زمني|timestamp)$/i.test(String(sh.getRange(1, 1).getValue()).trim()));
  if (!src) throw new Error('لم أجد ورقة ردود النموذج. اكتب اسمها في Settings ← FORM_TAB');
  const values = src.getDataRange().getValues();
  const h = values.shift().map(x => String(x).toLowerCase());
  // بعض الطوابع الزمنية مكتوبة يدوياً كنص — نحولها لتاريخ
  values.forEach(v => { v[0] = parseTimestamp_(v[0]); });
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
  values.forEach(v => { const k = keysOf(v); k.forEach(x => union(k[0], x)); });
  Object.keys(byEmail).forEach(e => { if (parent['e:' + e]) union('e:' + e, 'e:' + e); });
  const known = {};
  const claim = (key, u) => { if (!parent[key]) return; const r = find(key); if (!known[r]) known[r] = u; };
  Object.keys(byEmail).forEach(e => claim('e:' + e, byEmail[e]));
  Object.keys(byName).forEach(n => claim('n:' + n, byName[n]));

  // مجموعات بدون حساب معروف ⇐ ممرضات غير موجودات في القائمة: ننشئ لهن حسابات
  const recentCut = dateStr_(addDays_(new Date(), -35));
  const groups = {};
  values.forEach(v => {
    const k = keysOf(v);
    if (!(v[C.ts] instanceof Date) || !k.length) return;
    const root = find(k[0]);
    if (known[root]) return;
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

  const done = {};
  rows_(S.REPORTS).forEach(r => { if (String(r.source).indexOf('legacy:') === 0) done[r.source] = 1; });
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
    if (done[source] || !(v[C.ts] instanceof Date)) return;
    const rawName = String(v[C.name] || '').trim();
    const u = resolveUser(v);
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
  if (reports.length) appendObjects_(S.REPORTS, reports);

  // تاريخ بداية المسؤولية = أول تقرير للممرضة (إذا كان فارغاً أو أحدث من أول تقرير)
  const first = {};
  rows_(S.REPORTS).forEach(r => { if (r.username && (!first[r.username] || r.week_start < first[r.username])) first[r.username] = r.week_start; });
  rows_(S.USERS).forEach(u => {
    const f = first[u.username];
    if (u.role === 'nurse' && f && (!u.start_date || dateStr_(parseDate_(u.start_date)) > f)) setCell_(S.USERS, u._row, 'start_date', f);
  });
  SpreadsheetApp.getActive().toast('تم نقل ' + reports.length + ' تقرير، وإنشاء ' + createdUsers.length +
    ' حساب ممرضة (راجع ورقة Users وورقة Temp_Passwords)', APP.NAME, 10);
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

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sh_(name) {
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
  return s;
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
