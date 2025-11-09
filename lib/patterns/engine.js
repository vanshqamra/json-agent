import fs from 'node:fs/promises';
import path from 'node:path';

import { dedupeRows } from '../utils/dedupeRows.js';

function toLower(text) {
  return String(text || '').toLowerCase();
}

function normaliseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parsePatternFile(contents, filename) {
  try {
    return { pattern: JSON.parse(contents), error: null };
  } catch (error) {
    return { pattern: null, error: new Error(`Failed to parse pattern ${filename}: ${error.message}`) };
  }
}

export async function loadPatternRegistry(patternsDir) {
  const patterns = [];
  const errors = [];
  try {
    const entries = await fs.readdir(patternsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      const filePath = path.join(patternsDir, entry.name);
      const contents = await fs.readFile(filePath, 'utf8');
      const { pattern, error } = parsePatternFile(contents, entry.name);
      if (pattern) {
        patterns.push({ ...pattern, filename: entry.name });
      } else if (error) {
        errors.push(error.message);
      }
    }
  } catch (error) {
    errors.push(`registry_read_failed:${error.message}`);
  }
  patterns.sort((a, b) => (b.columns?.length || 0) - (a.columns?.length || 0));
  return { patterns, errors };
}

function parseNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized = cleaned;
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) {
      normalized = cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    }
  } else if (hasComma) {
    const lastIndex = cleaned.lastIndexOf(',');
    const decimalCandidate = cleaned.length - lastIndex - 1;
    if (decimalCandidate === 2) {
      normalized = cleaned.replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  }
  const parsed = Number.parseFloat(normalized.replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function detectCurrency(value, currencyConfig = {}) {
  if (!value) return { currency: currencyConfig.default || null, amount: parseNumber(value) };
  const lowered = toLower(value);
  const symbols = currencyConfig.symbols || {};
  for (const symbol of Object.keys(symbols)) {
    if (value.includes(symbol) || lowered.includes(symbol.toLowerCase())) {
      const amount = parseNumber(value);
      return { currency: symbols[symbol], amount };
    }
  }
  const codes = currencyConfig.codes || {};
  for (const key of Object.keys(codes)) {
    if (lowered.includes(key)) {
      const amount = parseNumber(value);
      return { currency: codes[key], amount };
    }
  }
  const amount = parseNumber(value);
  return { currency: amount != null ? currencyConfig.default || null : null, amount };
}

function normalisePack(value, unitsConfig = {}) {
  const raw = normaliseWhitespace(value);
  if (!raw) return null;
  const packPatterns = Array.isArray(unitsConfig.pack) ? unitsConfig.pack : [];
  for (const entry of packPatterns) {
    if (!entry || !entry.pattern) continue;
    const re = new RegExp(entry.pattern, 'i');
    const match = raw.match(re);
    if (match) {
      if (entry.format) {
        return raw.replace(re, entry.format);
      }
      return match[0];
    }
  }
  return raw;
}

function splitColumns(line) {
  if (!line) return [];
  const trimmed = String(line).trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/\s{2,}|\t|\s\|\s/).map(part => part.trim()).filter(Boolean);
  if (tokens.length > 1) return tokens;
  return [trimmed];
}

const SEGMENT_PRICE_REGEX = /(₹|Rs\.?|INR|€|EUR|\$|USD)?\s*(?:\d{1,3}(?:,\d{3})+|\d{2,})(?:\.\d+)?(?!\s*%)/gi;
const SEGMENT_CODE_REGEX = /([A-Z0-9]{3,}(?:-[A-Z0-9]+)+|\b\d{6,}\b|\b\d{4,}-\d{2,}\b|\b[A-Z]{2,}\d{3,}\b)/g;

function segmentByPriceAndCode(text) {
  if (!text) return [];
  const fragments = [];
  SEGMENT_PRICE_REGEX.lastIndex = 0;
  let match;
  let lastEnd = 0;
  while ((match = SEGMENT_PRICE_REGEX.exec(text)) != null) {
    const priceStart = match.index;
    const priceEnd = SEGMENT_PRICE_REGEX.lastIndex;
    const searchSlice = text.slice(lastEnd, priceStart);
    let codeMatch = null;
    SEGMENT_CODE_REGEX.lastIndex = 0;
    let local;
    while ((local = SEGMENT_CODE_REGEX.exec(searchSlice)) != null) {
      codeMatch = { index: lastEnd + local.index, token: local[0] };
    }
    if (!codeMatch) continue;
    const fragment = text.slice(codeMatch.index, priceEnd).trim();
    if (!fragment) continue;
    fragments.push(fragment);
    lastEnd = priceEnd;
  }
  return fragments;
}

function alignTokens(tokens, columnCount) {
  if (columnCount <= 1) {
    return [tokens.join(' ')];
  }
  if (tokens.length === columnCount) return tokens;
  if (tokens.length > columnCount) {
    const aligned = tokens.slice(0, columnCount - 1);
    aligned.push(tokens.slice(columnCount - 1).join(' '));
    return aligned;
  }
  const padded = [...tokens];
  while (padded.length < columnCount) padded.push('');
  return padded;
}

const FIELD_ORDER = ['code', 'cas', 'name', 'pack', 'price_value', 'currency', 'notes'];

function fieldsToBitmask(fieldsPresent) {
  let mask = 0;
  for (const field of fieldsPresent) {
    const index = FIELD_ORDER.indexOf(field);
    if (index >= 0) {
      mask |= 1 << index;
    }
  }
  return mask;
}

function buildRowFromTokens(tokens, pattern, sourceLine) {
  const columns = pattern.columns || [];
  const columnCount = columns.length;
  const aligned = alignTokens(tokens, columnCount);
  const row = {
    code: null,
    cas: null,
    name: null,
    pack: null,
    price_value: null,
    currency: null,
    notes: null,
    confidence: 0,
    fields_present: [],
    fields_bitmask: 0,
    source: sourceLine,
  };
  const unitsConfig = pattern.normalization?.units || {};
  const currencyConfig = pattern.normalization?.currency || {};

  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const token = aligned[index] || '';
    const trimmed = normaliseWhitespace(token);
    if (!column || !column.role) continue;
    const role = column.role;
    if (role === 'code') {
      if (trimmed && (!column.value_regex || new RegExp(column.value_regex, 'i').test(trimmed))) {
        row.code = trimmed;
      }
    } else if (role === 'cas') {
      if (trimmed && (!column.value_regex || new RegExp(column.value_regex, 'i').test(trimmed))) {
        row.cas = trimmed;
      }
    } else if (role === 'name') {
      if (trimmed) {
        row.name = trimmed;
      }
    } else if (role === 'pack') {
      if (trimmed) {
        row.pack = normalisePack(trimmed, unitsConfig);
      }
    } else if (role === 'price') {
      const price = detectCurrency(trimmed, currencyConfig);
      if (price.amount != null) {
        row.price_value = price.amount;
      }
      if (price.currency) {
        row.currency = price.currency;
      }
    } else if (role === 'notes') {
      if (trimmed) {
        row.notes = trimmed;
      }
    }
  }

  const fieldsPresent = [];
  if (row.code) fieldsPresent.push('code');
  if (row.cas) fieldsPresent.push('cas');
  if (row.name) fieldsPresent.push('name');
  if (row.pack) fieldsPresent.push('pack');
  if (row.price_value != null) fieldsPresent.push('price_value');
  if (row.currency) fieldsPresent.push('currency');
  if (row.notes) fieldsPresent.push('notes');
  row.fields_present = fieldsPresent;
  row.fields_bitmask = fieldsToBitmask(fieldsPresent);

  let confidence = 0.35;
  if (row.name) confidence += 0.25;
  if (row.price_value != null) confidence += 0.25;
  if (row.code) confidence += 0.05;
  if (row.pack) confidence += 0.05;
  if (row.cas) confidence += 0.05;
  if (row.currency) confidence += 0.05;
  row.confidence = Math.min(0.99, confidence);

  return row;
}

function isHeaderMatch(line, pattern) {
  const text = toLower(line.text || line.source || '');
  const columns = pattern.columns || [];
  let matched = 0;
  let requiredSatisfied = 0;
  for (const column of columns) {
    if (!column) continue;
    const keywords = Array.isArray(column.header_keywords) ? column.header_keywords : [];
    const hasKeyword = keywords.some(keyword => text.includes(keyword.toLowerCase()));
    if (hasKeyword) {
      matched += 1;
      if (column.required) {
        requiredSatisfied += 1;
      }
    } else if (column.required) {
      return false;
    }
  }
  if (columns.some(col => col.required)) {
    return requiredSatisfied === columns.filter(col => col.required).length;
  }
  return matched >= Math.max(1, Math.floor(columns.length / 2));
}

function findHeaderLine(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isHeaderMatch(line, pattern)) {
      return index;
    }
  }
  return -1;
}

function extractLinesFromPages(pages) {
  const lines = [];
  for (const page of pages || []) {
    const pageNumber = page.pageNumber || page.page || null;
    if (Array.isArray(page.textBlocks)) {
      for (const block of page.textBlocks) {
        const blockId = block.id || block.blockId || null;
        const text = String(block.text || '').split(/\n+/);
        for (const entry of text) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          lines.push({
            text: trimmed,
            pageNumber,
            blockId,
          });
        }
      }
    }
    if (Array.isArray(page.segments)) {
      for (const segment of page.segments) {
        const text = String(segment.text || '').trim();
        if (!text) continue;
        lines.push({
          text,
          pageNumber,
          blockId: segment.id || null,
        });
      }
    }
    if (Array.isArray(page.tables)) {
      for (const table of page.tables) {
        if (Array.isArray(table.header)) {
          lines.push({
            text: table.header.join('    '),
            pageNumber,
            blockId: table.id || null,
          });
        }
        for (const row of table.rows || []) {
          lines.push({
            text: row.join('    '),
            pageNumber,
            blockId: table.id || null,
          });
        }
      }
    }
  }
  return lines;
}

export class PatternEngine {
  constructor(patterns = [], options = {}) {
    this.patterns = patterns;
    this.options = options;
  }

  getOrderedPatterns() {
    if (!Array.isArray(this.options?.preferredPatterns) || !this.options.preferredPatterns.length) {
      return this.patterns;
    }
    const preferred = [];
    const seen = new Set();
    for (const hint of this.options.preferredPatterns) {
      const normalised = String(hint || '').trim();
      if (!normalised) continue;
      const found = this.patterns.find(pattern => {
        const id = pattern.id || pattern.filename || '';
        return id === normalised;
      });
      if (found && !seen.has(found)) {
        preferred.push(found);
        seen.add(found);
      }
    }
    const remainder = this.patterns.filter(pattern => !seen.has(pattern));
    return [...preferred, ...remainder];
  }

  tryPattern(pattern, lines) {
    const headerIndex = findHeaderLine(lines, pattern);
    if (headerIndex === -1) {
      return { rows: [], reason: 'header_not_found' };
    }
    const dataLines = [];
    for (const rawLine of lines.slice(headerIndex + 1)) {
      const fragments = segmentByPriceAndCode(rawLine.text);
      if (fragments.length > 1) {
        for (const fragment of fragments) {
          dataLines.push({ ...rawLine, text: fragment });
        }
      } else {
        dataLines.push(rawLine);
      }
    }
    const rows = [];
    const leftovers = [];
    const requiredRoles = pattern.validation?.required_roles || [];
    const minConfidence = pattern.validation?.min_confidence ?? 0;
    let lastRow = null;

    for (const line of dataLines) {
      const rawTokens = splitColumns(line.text);
      if (!rawTokens.length) {
        leftovers.push(line.text);
        continue;
      }
      const row = buildRowFromTokens(rawTokens, pattern, line);
      if (!row) {
        leftovers.push(line.text);
        continue;
      }
      const hasRequired = requiredRoles.every(role => {
        if (role === 'price') return row.price_value != null;
        if (role === 'name') return Boolean(row.name);
        if (role === 'code') return Boolean(row.code);
        if (role === 'cas') return Boolean(row.cas);
        if (role === 'pack') return Boolean(row.pack);
        return true;
      });
      if (!hasRequired || row.confidence < minConfidence) {
        if (lastRow && (!row.price_value || !row.name)) {
          if (!row.price_value && line.text) {
            lastRow.name = `${lastRow.name} ${line.text.trim()}`.trim();
            lastRow.confidence = Math.min(0.99, lastRow.confidence + 0.05);
            lastRow.fields_present = Array.from(new Set([...lastRow.fields_present, 'name']));
            lastRow.fields_bitmask = fieldsToBitmask(lastRow.fields_present);
            continue;
          }
        }
        leftovers.push(line.text);
        continue;
      }
      rows.push(row);
      lastRow = row;
    }

    return { rows, reason: rows.length ? 'matched' : 'no_rows', leftovers, headerIndex };
  }

  matchPages(pages, context = {}) {
    const lines = extractLinesFromPages(pages);
    const attempts = [];
    const orderedPatterns = this.getOrderedPatterns();
    for (const pattern of orderedPatterns) {
      const attempt = { pattern_id: pattern.id || pattern.filename, matched_rows: 0, reason: null };
      const { rows, reason, leftovers } = this.tryPattern(pattern, lines);
      attempt.matched_rows = rows.length;
      attempt.reason = reason;
      attempts.push(attempt);
      if (rows.length) {
        const { rows: dedupedRows, duplicates } = dedupeRows(rows);
        const variants = dedupedRows.map(row => ({
          code: row.code || null,
          cas: row.cas || null,
          name: row.name || '',
          pack: row.pack || null,
          price_value: row.price_value != null ? row.price_value : null,
          currency: row.currency || null,
          notes: row.notes || null,
          confidence: row.confidence,
          fields_present: row.fields_present,
        }));
        const qcReport = {
          docId: context.docId || null,
          engine: 'pattern_registry',
          matched_pattern: pattern.id || pattern.filename,
          matched_rows: variants.length,
          fields: FIELD_ORDER,
          rows: dedupedRows.map((row, index) => ({
            index,
            confidence: row.confidence,
            fields_present: row.fields_present,
            bitmask: row.fields_bitmask,
            source: row.source,
          })),
          leftovers,
          attempts,
          duplicates_removed: duplicates,
        };
        const group = {
          category: 'general',
          title: pattern.description || 'Catalog',
          description: '',
          specs_headers: [],
          variants,
          pageStart: variants.length ? dedupedRows[0]?.source?.pageNumber || null : null,
          pageEnd: variants.length
            ? dedupedRows[dedupedRows.length - 1]?.source?.pageNumber || null
            : null,
          source_docId: context.docId || null,
          qc_report: qcReport,
        };
        return {
          groups: [group],
          qcReport,
          diagnostics: {
            attempts,
            matchedPattern: pattern.id || pattern.filename,
            duplicatesRemoved: duplicates,
          },
          warnings: [],
        };
      }
    }
    return {
      groups: [],
      qcReport: {
        docId: context.docId || null,
        engine: 'pattern_registry',
        matched_pattern: null,
        matched_rows: 0,
        fields: FIELD_ORDER,
        rows: [],
        leftovers: lines.map(line => line.text),
        attempts,
      },
      diagnostics: {
        attempts,
        matchedPattern: null,
      },
      warnings: ['pattern_registry_no_match'],
    };
  }
}

