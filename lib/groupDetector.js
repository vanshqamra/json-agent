/**
 * Group Boundary Detector
 * Uses header-like lines, all-caps, repeated SKU prefixes, and page header repetition.
 */
const GROUP_TUNING = {
  maxHeaderGap: 4,
  carryHeaderAcrossPages: true
};

function skuPrefix(s) {
  const m = s.match(/([A-Z]{1,4})[\-\s]?\d/);
  return m ? m[1] : null;
}

export function detectGroups(pages) {
  const groups = [];
  let current = null;
  let lastHeader = null;
  let lastHeaderPage = -1;

  for (const page of pages) {
    for (const b of page.blocks) {
      if (b.type === 'header') {
        // new group boundary if far enough from last header or header changes
        const newTitle = b.text.replace(/\s{2,}/g,' ').trim();
        const isNew = !lastHeader || newTitle !== lastHeader || (page.index - lastHeaderPage) > 0;
        if (isNew) {
          if (current) groups.push(current);
          current = { title: newTitle, pageStart: page.index, blocks: [], variants: [], notes: [] };
          lastHeader = newTitle;
          lastHeaderPage = page.index;
          continue;
        }
      }
      if (!current) {
        // use first header-like or first sku/spec to start a group
        if (b.type === 'header' || b.type === 'sku' || b.type === 'spec_row') {
          current = { title: (b.type==='header'? b.text : 'UNTITLED'), pageStart: page.index, blocks: [], variants: [], notes: [] };
        } else {
          continue;
        }
      }
      // accumulate blocks
      if (b.type === 'footnote') current.notes.push(b.text);
      current.blocks.push({ ...b, pageIndex: page.index });
    }
  }
  if (current) groups.push(current);

  // infer category by keyword
  for (const g of groups) {
    const t = (g.title||'').toLowerCase();
    let category = 'general';
    if (/flask|bottle|beaker|jar|vial/.test(t)) category = 'glassware';
    if (/acid|solvent|reagent|salt|powder|solution/.test(t)) category = 'chemical';
    if (/filter|membrane|paper|syringe|column/.test(t)) category = 'consumable';
    g.category = category;
  }

  return groups;
}

export const GROUP_TUNING_CONST = GROUP_TUNING;
