// ===== DEBUG GUARD (shows errors on the page) =====
window.addEventListener("error", (e) => {
  const box = document.getElementById("loading");
  if (box) box.textContent = "JS Error: " + (e.message || "Unknown error");
});
window.addEventListener("unhandledrejection", (e) => {
  const box = document.getElementById("loading");
  if (box) box.textContent = "Promise Error: " + (e.reason?.message || e.reason || "Unknown rejection");
});

// ✅ 1) Apps Script Web App URL (ends with /exec)
const API_URL = "https://script.google.com/macros/s/AKfycbzhl-2eZ_BpEm-3KPGSMinySd2UY5E5PosKuhbw9YC-76BVHkNwE-dlbnW0TYz1CN-aig/exec";

// ✅ 2) Button links
const KOBO_ADD_CASE_URL        = "https://ee.kobotoolbox.org/x/bubc5Ju9";
const KOBO_RESIDENT_DATA_URL   = "https://kf.kobotoolbox.org/#/forms/apB4HwDv3mNjTwg38qxCu4/data/table";
const KOBO_FACULTY_DATA_URL    = "https://kf.kobotoolbox.org/#/forms/apB4HwDv3mNjTwg38qxCu4/data/table";

/*******************************************************
 * ER Psychiatry Dashboard (Static) - FINAL FAST VERSION
 * - JSONP + retries + cache-busting
 * - Loads STATS first (fast), then CASES (table)
 *******************************************************/

// 1) Apps Script Web App URL (ends with /exec)
const API_URL = "PASTE_YOUR_APPS_SCRIPT_WEBAPP_URL_HERE";

// 2) Button links
const KOBO_ADD_CASE_URL        = "https://ee.kobotoolbox.org/x/bubc5Ju9";
const KOBO_RESIDENT_DATA_URL   = "https://kf.kobotoolbox.org/#/forms/apB4HwDv3mNjTwg38qxCu4/data/table";
const KOBO_FACULTY_DATA_URL    = "https://kf.kobotoolbox.org/#/forms/apB4HwDv3mNjTwg38qxCu4/data/table";

// ---------- JSONP ----------
function jsonp(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const cbName = "cb_" + Math.random().toString(36).slice(2);

    function cleanup() {
      try { delete window[cbName]; } catch (_) {}
      if (script && script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    }

    window[cbName] = (data) => { cleanup(); resolve(data); };

    const script = document.createElement("script");
    script.src = url
      + (url.includes("?") ? "&" : "?")
      + "callback=" + cbName
      + "&_ts=" + Date.now(); // cache-bust (mobile + incognito reliability)

    script.onerror = () => { cleanup(); reject(new Error("JSONP FAILED")); };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP timeout"));
    }, timeoutMs);

    document.body.appendChild(script);
  });
}

async function jsonpRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await jsonp(url);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 600 * Math.pow(2, i))); // 0.6s,1.2s,2.4s
    }
  }
  throw lastErr;
}

// ---------- Keys ----------
const KEYS = {
  caseId:      ["auto_caseid", "Case ID", "Case_ID", "_id"],
  patientId:   ["Patient_ID", "Patient ID", "patient_id"],
  patientName: ["patient_name", "Name", "patient"],
  age:         ["Age"],
  sex:         ["Sex"],
  dept:        ["department_seen", "Department Seen", "Department"],
  bed:         ["Bed_No", "Bed No", "Bed"],
  resident:    ["case_seen_by", "Case Seen By", "Case  Seen By"],
  faculty:     ["faculty_name", "Faculty Consulted", "Faculty"],
  primaryDx:   ["Primary_Diagnosis", "Primary Diagnosis"],
  diagnosis:   ["diagnosis", "Diagnosis"],
  management:  ["Management"],
  submitted:   ["_submission_time", "submission_time", "start"],
  reviewRequired: ["Review_Required", "Review Required"],
  reviewDateTime: ["Review_Date_Time", "Review Date Time", "Review Date/Time"]
};

let RAW = [];
let VIEW = [];
let page = 1;
let pageSize = 25;
let sortKey = "submitted";
let sortDir = "desc";
let range = "all";

// ---------- Helpers ----------
function getAny(obj, arr){
  for(const k of arr){
    const v = obj?.[k];
    if(v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}
function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function normalizeStatus(r){
  const vs = r?._validation_status;
  const uid = String(vs?.uid || "").toLowerCase();
  const label = String(vs?.label || "").toLowerCase();

  if (uid.includes("approved") || label === "approved") return "approved";
  if (uid.includes("not_approved") || label.includes("not approved")) return "not_approved";
  if (uid.includes("on_hold") || uid.includes("onhold") || label.includes("on hold")) return "onhold";

  const s = String(getAny(r, ["status","Status"]) || "").trim().toLowerCase();
  if(s){
    if(s === "approved") return "approved";
    if(["rejected","not approved","not_approved","revision"].includes(s)) return "not_approved";
    if(["onhold","on hold","hold"].includes(s)) return "onhold";
    return "pending";
  }
  return "pending";
}
function statusLabel(s){
  if(s === "approved") return "✅ Approved";
  if(s === "not_approved") return "❌ Revision Needed";
  if(s === "onhold") return "⏸️ On Hold";
  return "⏳ Pending";
}
function normalizeReview(r){
  const req = String(getAny(r, KEYS.reviewRequired) || "").trim().toLowerCase();
  const dt  = String(getAny(r, KEYS.reviewDateTime) || "").trim();
  if(req === "yes" || req === "true"){
    return dt ? "reviewed" : "review_pending";
  }
  return "no_review";
}
function reviewLabel(s){
  if(s === "review_pending") return "🟧 Pending Review";
  if(s === "reviewed") return "🟦 To be review";
  return "⬜ Not Required";
}

// ---------- Range ----------
function setRange(rng){
  range = rng;
  ["all","today","7d","30d"].forEach(x => {
    const el = document.getElementById("rng_"+x);
    if(el) el.classList.toggle("active", x === rng);
  });
  applyFilters();
}
function inRange(ts){
  if(range === "all") return true;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if(range === "today") return ts >= startOfToday;
  const days = (range === "7d") ? 7 : 30;
  return ts >= (now.getTime() - days*24*60*60*1000);
}

// ---------- UI Builders ----------
function buildSelect(id, statsObj, placeholder){
  const sel = document.getElementById(id);
  if(!sel) return;
  const keep = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  Object.keys(statsObj).sort().forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${name} (${statsObj[name]})`;
    sel.appendChild(opt);
  });
  sel.value = keep;
}

// ---------- Fast refresh (stats first) ----------
async function refresh(){
  document.getElementById("loading").style.display = "block";
  document.getElementById("loading").textContent = "Loading dashboard…";
  document.getElementById("tbl").style.display = "none";

  // Ping (non-blocking)
  try{
    const p = await jsonpRetry(`${API_URL}?action=ping`, 2);
    if(p?.ok) document.getElementById("metaInfo").textContent = `• ${p.version}`;
  }catch(_){}

  // 1) Stats fast
  try{
    const s = await jsonpRetry(`${API_URL}?action=stats`, 3);
    if(s?.error) throw new Error(s.error + (s.message ? " - " + s.message : ""));

    document.getElementById("sTotal").textContent = s.stats?.total ?? 0;
    document.getElementById("sApproved").textContent = s.stats?.approved ?? 0;
    document.getElementById("sPending").textContent = s.stats?.pending ?? 0;
    document.getElementById("sOnHold").textContent = s.stats?.onhold ?? 0;
    document.getElementById("sNotApproved").textContent = s.stats?.not_approved ?? 0;

    document.getElementById("lastUpdated").textContent =
      s.lastUpdated ? new Date(s.lastUpdated).toLocaleString() : "—";

    if(s.meta?.version) {
      document.getElementById("metaInfo").textContent =
        `• ${s.meta.version} • cache ${s.meta.cacheSeconds || 0}s`;
    }

    buildSelect("fResident", s.residentStats || {}, "All residents");
    buildSelect("fFaculty", s.facultyStats || {}, "All faculty");

  }catch(err){
    document.getElementById("loading").textContent = "Error loading stats: " + (err.message || err);
    return;
  }

  // 2) Cases slower
  document.getElementById("loading").textContent = "Loading cases list…";
  try{
    const data = await jsonpRetry(`${API_URL}?action=data`, 3);
    render(data);
  }catch(err){
    document.getElementById("loading").textContent =
      "Cases list failed. Tap Refresh. (" + (err.message || err) + ")";
  }
}

function render(data){
  if(data?.error){
    document.getElementById("loading").textContent =
      `Error: ${data.error}${data.message ? (" - " + data.message) : ""}`;
    return;
  }

  RAW = (data.cases || []).map(r => {
    r.__status = normalizeStatus(r);
    r.__review = normalizeReview(r);
    r.__submitted_ts = new Date(getAny(r, KEYS.submitted) || 0).getTime();
    return r;
  });

  page = 1;
  applyFilters();

  document.getElementById("loading").style.display = "none";
  document.getElementById("tbl").style.display = "table";
}

// ---------- Filtering / sorting ----------
function applyFilters(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const st = document.getElementById("fStatus").value;
  const res = document.getElementById("fResident").value;
  const fac = document.getElementById("fFaculty").value;

  VIEW = RAW.filter(r => {
    const caseId = String(getAny(r, KEYS.caseId) || "").toLowerCase();
    const pid = String(getAny(r, KEYS.patientId) || "").toLowerCase();
    const pname = String(getAny(r, KEYS.patientName) || "").toLowerCase();

    const matchQ = !q || caseId.includes(q) || pid.includes(q) || pname.includes(q);
    const matchSt = !st || r.__status === st;
    const matchRes = !res || String(getAny(r, KEYS.resident)) === res;
    const matchFac = !fac || String(getAny(r, KEYS.faculty)) === fac;
    const matchRng = inRange(r.__submitted_ts);

    return matchQ && matchSt && matchRes && matchFac && matchRng;
  });

  sortAndRender();
}

function sortBy(key){
  if(sortKey === key) sortDir = (sortDir === "asc" ? "desc" : "asc");
  else { sortKey = key; sortDir = "asc"; }
  sortAndRender();
}

function getSortVal(r, key){
  if(key === "status") return r.__status;
  if(key === "review") return r.__review;
  if(key === "submitted") return r.__submitted_ts;

  const map = {
    caseId: KEYS.caseId,
    patientId: KEYS.patientId,
    patientName: KEYS.patientName,
    dept: KEYS.dept,
    bed: KEYS.bed,
    resident: KEYS.resident,
    faculty: KEYS.faculty,
    primaryDx: KEYS.primaryDx
  };
  return String(getAny(r, map[key] || []) || "").toLowerCase();
}

function sortAndRender(){
  const dir = (sortDir === "asc") ? 1 : -1;
  VIEW.sort((a,b)=>{
    const va = getSortVal(a, sortKey);
    const vb = getSortVal(b, sortKey);
    if(va < vb) return -1*dir;
    if(va > vb) return  1*dir;
    return 0;
  });
  renderPage();
}

function renderPage(){
  const total = VIEW.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(page, pages);

  const start = (page-1)*pageSize;
  const slice = VIEW.slice(start, start + pageSize);

  const tbody = document.getElementById("tbody");
  tbody.innerHTML = slice.map((r, idx) => {
    const st = r.__status;
    const rv = r.__review;
    const submitted = getAny(r, KEYS.submitted)
      ? new Date(getAny(r, KEYS.submitted)).toLocaleString()
      : "—";

    return `
      <tr>
        <td>${escapeHtml(getAny(r, KEYS.patientId) || "—")}</td>
        <td>${escapeHtml(getAny(r, KEYS.patientName) || "—")}</td>
        <td>${escapeHtml(getAny(r, KEYS.age) || "—")} / ${escapeHtml(getAny(r, KEYS.sex) || "—")}</td>
        <td class="col-dept">${escapeHtml(getAny(r, KEYS.dept) || "—")}</td>
        <td>${escapeHtml(getAny(r, KEYS.bed) || "—")}</td>
        <td>${escapeHtml(getAny(r, KEYS.resident) || "—")}</td>
        <td class="col-faculty">${escapeHtml(getAny(r, KEYS.faculty) || "—")}</td>
        <td class="col-primarydx">${escapeHtml(getAny(r, KEYS.primaryDx) || "—")}</td>
        <td><span class="badge b-${st}">${statusLabel(st)}</span></td>
        <td><span class="badge b-${rv}">${reviewLabel(rv)}</span></td>
        <td>${escapeHtml(submitted)}</td>
        <td><button class="btn" data-open="${start + idx}">View</button></td>
      </tr>
    `;
  }).join("");

  document.getElementById("pageInfo").textContent =
    `Page ${page}/${Math.max(1, Math.ceil(total/pageSize))} • ${total} cases`;

  document.querySelectorAll('button[data-open]').forEach(btn => {
    btn.addEventListener("click", () => openCase(parseInt(btn.dataset.open, 10)));
  });
}

function prevPage(){ page = Math.max(1, page-1); renderPage(); }
function nextPage(){
  const pages = Math.max(1, Math.ceil(VIEW.length / pageSize));
  page = Math.min(pages, page+1);
  renderPage();
}
function changePageSize(){
  pageSize = parseInt(document.getElementById("pageSize").value, 10) || 25;
  page = 1;
  renderPage();
}

// ---------- Modal ----------
function openCase(index){
  const r = VIEW[index];
  const st = r.__status;

  document.getElementById("mTitle").textContent =
    `${getAny(r, KEYS.patientId) || "—"} • ${getAny(r, KEYS.patientName) || "—"} • ${statusLabel(st)}`;

  const nicePairs = [
    ["Case ID", getAny(r, KEYS.caseId)],
    ["Patient ID", getAny(r, KEYS.patientId)],
    ["Patient Name", getAny(r, KEYS.patientName)],
    ["Age / Sex", `${getAny(r, KEYS.age) || "—"} / ${getAny(r, KEYS.sex) || "—"}`],
    ["Department", getAny(r, KEYS.dept)],
    ["Bed No", getAny(r, KEYS.bed)],
    ["Primary Diagnosis", getAny(r, KEYS.primaryDx)],
    ["Diagnosis", getAny(r, KEYS.diagnosis)],
    ["Management", getAny(r, KEYS.management)],
    ["Submitted", getAny(r, KEYS.submitted)]
  ];

  document.getElementById("mNice").innerHTML =
    nicePairs.filter(([k,v]) => String(v||"").trim() !== "")
      .map(([k,v]) => `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`)
      .join("") || `<div class="muted">No details</div>`;

  document.getElementById("mBody").textContent = JSON.stringify(r, null, 2);

  switchTab("nice");
  document.getElementById("mb").style.display = "flex";
}

function switchTab(which){
  const nice = document.getElementById("mNice");
  const json = document.getElementById("mJson");
  document.getElementById("tab_nice").classList.toggle("active", which === "nice");
  document.getElementById("tab_json").classList.toggle("active", which === "json");
  nice.style.display = (which === "nice") ? "block" : "none";
  json.style.display = (which === "json") ? "block" : "none";
}

function closeModal(){ document.getElementById("mb").style.display = "none"; }

// ---------- Wire events ----------
document.getElementById("btnRefresh").addEventListener("click", refresh);

document.querySelectorAll(".chip[data-range]").forEach(ch => {
  ch.addEventListener("click", () => setRange(ch.dataset.range));
});

document.getElementById("q").addEventListener("input", applyFilters);
document.getElementById("fStatus").addEventListener("change", applyFilters);
document.getElementById("fResident").addEventListener("change", applyFilters);
document.getElementById("fFaculty").addEventListener("change", applyFilters);

document.getElementById("pageSize").addEventListener("change", changePageSize);
document.getElementById("btnPrev").addEventListener("click", prevPage);
document.getElementById("btnNext").addEventListener("click", nextPage);

document.getElementById("btnCloseModal").addEventListener("click", closeModal);
document.getElementById("mb").addEventListener("click", (e) => { if (e.target.id === "mb") closeModal(); });

document.querySelectorAll(".tab[data-tab]").forEach(t => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

// Sort header clicks
document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => sortBy(th.dataset.sort));
});

// Wire 3 button links (kept in JS so you can change once)
document.getElementById("btnAddCase").href = KOBO_ADD_CASE_URL;
document.getElementById("btnResidentData").href = KOBO_RESIDENT_DATA_URL;
document.getElementById("btnFacultyData").href = KOBO_FACULTY_DATA_URL;

// Initial load
refresh();


