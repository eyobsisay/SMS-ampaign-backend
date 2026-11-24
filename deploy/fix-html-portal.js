const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(file, 'utf8');

const masterStart = html.indexOf('<!-- Master admin app -->');
if (masterStart < 0) throw new Error('master-app marker missing');

const afterMaster = html.slice(masterStart);
const createStart = afterMaster.indexOf('<div id="create-company-panel"');
const editStart = afterMaster.indexOf('<div id="edit-company-panel"');
if (createStart < 0 || editStart < 0) throw new Error('panels missing in master');

const editRel = afterMaster.slice(editStart);
const editEndMatch = editRel.match(/<\/form>\s*<\/div>/);
if (!editEndMatch) throw new Error('edit end not found');
const editEnd = editStart + editEndMatch.index + editEndMatch[0].length;
const panelsHtml = afterMaster.slice(createStart, editEnd);

const emptyRe =
  /<div id="create-company-panel" class="hidden bg-white rounded-2xl border border-slate-200\/80 shadow-panel p-6 max-w-3xl"><\/div>\s*<div id="edit-company-panel" class="hidden bg-white rounded-2xl border border-slate-200\/80 shadow-panel p-6 max-w-4xl"><\/div>/;
if (!emptyRe.test(html)) throw new Error('empty placeholders not found');
html = html.replace(emptyRe, panelsHtml);

html = html.replace(/\s*<!-- Master admin app -->[\s\S]*?(?=\s*<!-- Create Campaign popup -->)/, '\n\n  ');

fs.writeFileSync(file, html);
console.log({
  masterAppGone: !html.includes('id="master-app"'),
  createPanels: (html.match(/id="create-company-panel"/g) || []).length,
  editPanels: (html.match(/id="edit-company-panel"/g) || []).length,
});
