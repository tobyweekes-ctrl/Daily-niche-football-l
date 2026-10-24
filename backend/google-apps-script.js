// Deep Cut answer log — paste into Extensions → Apps Script of a Google Sheet.
// Setup steps are in backend/README.md.
//
// POST (from the game): appends one row per submitted answer.
// GET  (for tools/retier.mjs): returns every row as JSON.

const SHEET_NAME = 'answers';
const HEADER = ['timestamp', 'date', 'mode', 'promptId', 'input', 'matched', 'status'];

function doPost(e) {
  let entry;
  try { entry = JSON.parse(e.postData.contents); } catch (err) { return text_('bad json'); }
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    sheet_().appendRow([
      new Date(),
      clean_(entry.date, 10),
      clean_(entry.mode, 10),
      clean_(entry.promptId, 60),
      clean_(entry.input, 80),
      clean_(entry.matched, 80),
      clean_(entry.status, 12),
    ]);
  } finally {
    lock.releaseLock();
  }
  return text_('ok');
}

function doGet() {
  const rows = sheet_().getDataRange().getValues();
  return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Trim, cap length, and stop typed text like "=IMPORTXML(...)" being run as a formula.
function clean_(value, max) {
  const s = String(value == null ? '' : value).trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function text_(s) {
  return ContentService.createTextOutput(s);
}
