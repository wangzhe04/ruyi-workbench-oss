'use strict';

export function reportPlainText(value) {
  return String(value || '').trim()
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

export function reportConclusionExcerpt(value, limit = 1200) {
  const full = reportPlainText(value);
  if (!full) return '';
  const markers = ['已汇总完毕', '任务标记完成', '提交摘要', '确认最终状态', '已完成', '最终总结', '结论', 'Completed', 'Final summary', 'Conclusion'];
  let markerAt = -1;
  for (const marker of markers) markerAt = Math.max(markerAt, full.lastIndexOf(marker));
  if (markerAt > 0 && full.length - markerAt >= 80) return full.slice(markerAt).trim();
  if (full.length <= limit) return full;
  const tail = full.slice(-limit);
  const paragraphAt = tail.indexOf('\n\n');
  return `${paragraphAt >= 0 ? tail.slice(paragraphAt + 2) : tail}`.trim();
}

export function narrativePlainText(value) {
  return reportPlainText(value).replace(/\s+/g, ' ');
}

export function reportDeliveryText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const headingAt = raw.search(/#{1,6}[ \t]+\S/);
  if (headingAt < 0) return raw;
  const beforeHeading = raw.slice(0, headingAt);
  const sourceNote = beforeHeading.match(/(?:^|\n\s*\n)((?:>[ \t]?.*(?:\n|$))+)[ \t\n]*$/);
  return `${sourceNote ? `${sourceNote[1].trim()}\n\n` : ''}${raw.slice(headingAt).trim()}`;
}

export function reportPreviewText(value, limit = 260) {
  const markdown = reportDeliveryText(value);
  if (!markdown) return '';
  const heading = markdown.match(/^#{1,6}[ \t]+(.+)$/m)?.[1] || '';
  const prose = markdown.split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(block => block
      && !/^#{1,6}[ \t]+/.test(block)
      && !/^```/.test(block)
      && !block.split('\n').some(line => /^\s*\|?.*\|\s*:?-{3,}/.test(line)))
    .map(block => reportPlainText(block)
      .replace(/^\s*>[ \t]?/gm, '')
      .replace(/^\s*[-*+][ \t]+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim())
    .find(Boolean) || '';
  return [reportPlainText(heading), prose].filter(Boolean).join(' · ').slice(0, limit);
}
