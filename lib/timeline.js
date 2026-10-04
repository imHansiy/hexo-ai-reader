'use strict';

// 独立接口：未来 forced alignment 只需返回同样的 segments / alignment。
const normalize = text => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const weight = text => Math.max(1, [...text].length + (text.match(/[，、；：,.!?。！？]/g) || []).length * 2.5);

function estimate(segments, duration, reason = '未提供可用的官方字级时间戳') {
  const total = segments.reduce((sum, segment) => sum + weight(segment.text), 0);
  let cursor = 0;
  return {
    alignment: { method: 'estimated', precise: false, reason },
    segments: segments.map((segment, index) => {
      const start = cursor;
      cursor = index === segments.length - 1 ? duration : cursor + duration * weight(segment.text) / total;
      return { ...segment, start, end: cursor };
    })
  };
}

function alignSegments(segments, duration, sentences = []) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('音频时长无效');
  const words = [...sentences].sort((a, b) => a.index - b.index).flatMap(s => s.words || [])
    .filter(word => normalize(word.text));
  const expected = segments.map(segment => normalize(segment.text));
  const spoken = words.map(word => normalize(word.text)).join('');
  // 数字规范化/漏词/局部时间戳等不能冒充精确对齐。保守降级，不做 DOM 模糊查找。
  let previous = -1;
  const valid = words.length && words.every(word => {
    const start = word.begin_time / 1000, end = word.end_time / 1000;
    const ok = Number.isFinite(start) && Number.isFinite(end) && start >= previous && end >= start && end <= duration + 0.25;
    previous = end;
    return ok;
  });
  if (!valid || spoken !== expected.join('')) return estimate(segments, duration);
  const positions = [];
  let offset = 0;
  for (const word of words) {
    positions.push({ start: offset, end: offset + normalize(word.text).length, time: word.begin_time / 1000 });
    offset += normalize(word.text).length;
  }
  offset = 0;
  const starts = expected.map(text => {
    const position = positions.find(word => word.start <= offset && word.end > offset);
    offset += text.length;
    return position?.time;
  });
  if (starts.some((start, index) => !Number.isFinite(start) || (index && start <= starts[index - 1]))) {
    return estimate(segments, duration, '官方字边界无法区分导读段落');
  }
  return {
    alignment: { method: 'dashscope-word-timestamps', precise: true },
    segments: segments.map((segment, index) => ({ ...segment,
      start: index === 0 ? 0 : starts[index], end: starts[index + 1] ?? duration }))
  };
}

// 短句优先在句号、逗号或空格处断开；长串按 Unicode 字符分割，保留全部正文。
function splitCaptions(text, limit = 32) {
  const remaining = [...text.trim()], cues = [];
  while (remaining.length) {
    const size = Math.min(limit, remaining.length);
    let end = remaining.slice(0, size).findIndex(c => /[。！？!?；;]/u.test(c));
    if (end >= 0) end += 1;
    else if (remaining.length > limit) {
      end = 0;
      for (let i = 0; i < size; i++) if (/[，、：,:\s]/u.test(remaining[i])) end = i + 1;
      if (end < size / 2) end = size;
    } else end = size;
    // 句尾的引号不单独成为下一条字幕。
    while (end < remaining.length && /[”’」』]/u.test(remaining[end])) end++;
    const cue = remaining.splice(0, end).join('').trim();
    if (cue) cues.push(cue);
  }
  return cues;
}

function createTimeline(segments, duration, sentences = []) {
  const timeline = alignSegments(segments, duration, sentences);
  const groups = timeline.segments.map(segment => ({ segment, cues: splitCaptions(segment.text).map(text => ({ text, segmentId: segment.id })) }));
  const exact = alignSegments(groups.flatMap(group => group.cues), duration, sentences);
  if (timeline.alignment.precise && exact.alignment.precise) {
    return { ...timeline, captions: exact.segments, captionAlignment: exact.alignment };
  }
  // 估算字幕严格限制在原有导读段内，防止短句拆分改变正文高亮的段落边界。
  const captions = groups.flatMap(({ segment, cues }) => estimate(cues, segment.end - segment.start).segments
    .map(cue => ({ ...cue, start: cue.start + segment.start, end: cue.end + segment.start })));
  return { ...timeline, captions, captionAlignment: { method: 'estimated', precise: false } };
}

module.exports = { createTimeline, estimate, normalize, splitCaptions };
