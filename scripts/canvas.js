import fs from 'fs/promises';
import path from 'path';

function variantPreview(variant) {
  const specEntries = Object.entries(variant.specs || {}).slice(0, 2);
  const specsText = specEntries
    .map(([key, value]) => `${key}: ${value ?? '—'}`)
    .join(', ');
  const priceText = variant.price.list != null
    ? `${variant.price.currency ?? ''} ${variant.price.list}${variant.price.unit ? ` / ${variant.price.unit}` : ''}`.trim()
    : '—';
  return `- **Code:** ${variant.code ?? '—'} | **Name:** ${variant.name ?? '—'} | **Specs:** ${specsText || '—'} | **Price:** ${priceText}`;
}

export async function writeCanvasSummary(outputPath, { meta, products }, diagnostics) {
  const lines = [];
  lines.push('# Products Extraction Summary');
  lines.push('');
  lines.push(`- **Source:** ${meta.source_file}`);
  lines.push(`- **Generated:** ${meta.generated_at}`);
  lines.push(`- **Pages Processed:** ${meta.pages_processed}`);
  lines.push(`- **Intro Pages:** ${meta.intro_pages.length ? meta.intro_pages.join(', ') : 'None'}`);
  lines.push(`- **Product Groups:** ${products.length}`);
  const totalVariants = products.reduce((sum, product) => sum + product.variants.length, 0);
  lines.push(`- **Total Variants:** ${totalVariants}`);
  lines.push('');

  lines.push('## Product Groups');
  lines.push('');
  products.forEach((product, idx) => {
    lines.push(`### ${idx + 1}. ${product.title}`);
    lines.push(`- Category: ${product.category ?? '—'}`);
    if (product.description) {
      lines.push(`- Description: ${product.description}`);
    }
    lines.push(`- Headers: ${product.specs_headers.join(', ') || '—'}`);
    const preview = product.variants.slice(0, 3).map(variantPreview);
    if (preview.length) {
      lines.push('- Preview Variants:');
      lines.push(...preview);
    } else {
      lines.push('- Preview Variants: none');
    }
    lines.push('');
  });

  lines.push('## Errors & Warnings');
  lines.push('');
  const { report } = diagnostics;
  if (report.schema_issues.length === 0 && report.price_parse_failures.length === 0 && report.unmapped_lines.length === 0 && report.weak_tables.length === 0 && report.duplicate_codes.length === 0 && report.blocking.length === 0) {
    lines.push('- None');
  } else {
    if (report.schema_issues.length) {
      lines.push('- **Schema Issues:**');
      report.schema_issues.forEach(issue => {
        lines.push(`  - ${issue.path}: ${issue.message}`);
      });
    }
    if (report.price_parse_failures.length) {
      lines.push('- **Price Parse Failures:**');
      report.price_parse_failures.forEach(entry => {
        lines.push(`  - Page ${entry.page} (${entry.heading || 'unknown heading'}): value "${entry.value}"`);
      });
    }
    if (report.duplicate_codes.length) {
      lines.push('- **Duplicate Codes:**');
      report.duplicate_codes.forEach(entry => {
        lines.push(`  - Page ${entry.page} (${entry.heading || 'unknown heading'}): code ${entry.code} repeated ${entry.count} times`);
      });
    }
    if (report.weak_tables.length) {
      lines.push('- **Weak Table Detection:**');
      report.weak_tables.forEach(entry => {
        lines.push(`  - Page ${entry.page} (${entry.heading || 'unknown heading'}) with headers ${entry.headers.join(', ')}`);
      });
    }
    if (report.unmapped_lines.length) {
      lines.push('- **Unmapped Lines:**');
      report.unmapped_lines.forEach(entry => {
        lines.push(`  - Page ${entry.page}: ${entry.text}`);
      });
    }
    if (report.blocking.length) {
      lines.push('- **Blocking Issues:**');
      report.blocking.forEach(entry => {
        lines.push(`  - ${entry}`);
      });
    }
  }

  const finalPath = path.resolve(outputPath);
  await fs.writeFile(finalPath, lines.join('\n'), 'utf8');
  return finalPath;
}
