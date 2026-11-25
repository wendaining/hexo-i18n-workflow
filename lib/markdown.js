'use strict';

const crypto = require('node:crypto');
const frontMatter = require('hexo-front-matter');
const grayMatter = require('gray-matter');
const yaml = require('js-yaml');
const MarkdownIt = require('markdown-it');
const texmath = require('markdown-it-texmath');
const katex = require('katex');
const { load } = require('cheerio');

const TEXT_FENCE_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext', 'output', 'console', 'log', 'markdown', 'md']);
const md = new MarkdownIt({ html: true, linkify: false })
  .use(require('@traptitech/markdown-it-katex'))
  .use(texmath, { engine: katex, delimiters: 'brackets' });
for (const rule of texmath.rules.brackets.block) {
  md.block.ruler.at(rule.name, texmath.block(rule), { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}
md.inline.ruler.before('escape', 'math_inline_double', texmath.inline(texmath.rules.dollars.inline[0]));
md.renderer.rules.math_inline_double = (tokens, index) => katex.renderToString(tokens[index].content, { displayMode: true });

function normalizeNewlines(text) { return String(text == null ? '' : text).replace(/\r\n?/g, '\n'); }
function hashText(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }

function parseFrontMatter(text) {
  const raw = normalizeNewlines(text);
  const split = frontMatter.split(raw);
  const separator = raw.startsWith('---\n') ? '---' : raw.startsWith(';;;\n') ? ';;;' : null;
  let body = split.content;
  let metadata = split.data || '';
  let data;
  if (separator) {
    const parsed = grayMatter(raw, {
      delimiters: separator,
      language: separator === '---' ? 'yaml' : 'json',
      engines: {
        yaml: source => yaml.load(source),
        json: source => JSON.parse(`{${source}}`)
      }
    });
    // Gray Matter consumes only the opening delimiter when the closing boundary is absent.
    if (raw.length - parsed.matter.length - parsed.content.length === separator.length) throw new Error('Malformed front matter: missing closing delimiter');
    body = parsed.content;
    metadata = split.data == null ? parsed.matter : split.data;
    data = parsed.data;
  } else {
    data = split.data == null ? {} : split.separator.startsWith(';')
      ? JSON.parse(`{${split.data}}`)
      : yaml.load(split.data);
  }
  if (data == null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Front matter must be a mapping');
  return { data, body, frontMatter: metadata, raw };
}

function parseTokens(body) { return md.parse(normalizeNewlines(body), {}); }
function isTextFence(fence) { return TEXT_FENCE_LANGUAGES.has(String(fence.info || '').trim().split(/\s+/)[0].toLowerCase()); }
function isTranslatableFence(fence) { return isTextFence(fence); }

function extractFencedCode(text) {
  const body = normalizeNewlines(text);
  const lines = body.split('\n');
  const offsets = [0];
  for (let index = 0; index < lines.length; index++) offsets.push(offsets[index] + lines[index].length + 1);
  return parseTokens(body).filter(token => token.type === 'fence').map(token => {
    const [start, end] = token.map;
    const startOffset = offsets[start];
    const endOffset = Math.min(body.length, offsets[end] - (body[offsets[end] - 1] === '\n' ? 1 : 0));
    return { info: token.info, marker: token.markup, start, end: end - 1, startOffset, endOffset, text: body.slice(startOffset, endOffset), content: token.content };
  });
}

function hashSection(text) {
  let normalized = normalizeNewlines(text);
  const fences = extractFencedCode(normalized).filter(fence => !isTextFence(fence));
  for (let index = fences.length - 1; index >= 0; index--) {
    const fence = fences[index];
    normalized = normalized.slice(0, fence.startOffset) + normalized.slice(fence.endOffset);
  }
  return hashText(normalized.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

function parseSections(body) {
  const normalized = normalizeNewlines(body);
  const lines = normalized.split('\n');
  const tokens = parseTokens(normalized);
  const headings = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open' && token.level === 0) {
      headings.push({ start: token.map[0], level: Number(token.tag.slice(1)), heading: tokens[index + 1].content });
    }
  }
  const ranges = [{ start: 0, level: 0, heading: '' }, ...headings];
  const sections = [];
  for (let index = 0; index < ranges.length; index++) {
    const section = ranges[index];
    const end = index + 1 < ranges.length ? ranges[index + 1].start : lines.length;
    const text = lines.slice(section.start, end).join('\n');
    if (section.level === 0 && !text.trim()) continue;
    sections.push({ index: sections.length, level: section.level, heading: section.heading, key: section.level === 0 ? 'root' : `section:${sections.length}:${section.level}`, text, hash: hashSection(text) });
  }
  return sections;
}

function documentSections(text) {
  const parsed = parseFrontMatter(text);
  return { ...parsed, sections: parseSections(parsed.body) };
}

function inlineTokens(tokens) { return tokens.flatMap(token => token.children || []); }
function mathKey(values) {
  const expressions = new Set();
  for (const value of values) {
    for (const part of value.replace(/\s+/g, '').split('、')) if (part) expressions.add(part);
  }
  return [...expressions].sort().join('|');
}

function extractDisplayMath(text) {
  const tokens = parseTokens(text);
  return [...tokens, ...inlineTokens(tokens)].filter(token => token.type.startsWith('math_')).map(token => token.content);
}

function extractLinkTargets(text) {
  const tokens = parseTokens(text);
  const targets = [];
  for (const token of [...tokens, ...inlineTokens(tokens)]) {
    if (token.type === 'link_open') targets.push({ kind: 'link', target: token.attrGet('href') });
    if (token.type === 'image') targets.push({ kind: 'image', target: token.attrGet('src') });
    if (token.type === 'html_block' || token.type === 'html_inline') {
      const $ = load(token.content, {}, false);
      $('a[href],img[src],script[src],link[href]').each((_, element) => {
        const name = element.name;
        targets.push({ kind: 'html', target: $(element).attr(name === 'img' || name === 'script' ? 'src' : 'href') });
      });
    }
  }
  return targets;
}

function structureSignature(text) {
  const tokens = parseTokens(text);
  const inline = inlineTokens(tokens);
  const tables = [];
  let row = null;
  for (const token of tokens) {
    if (token.type === 'tr_open') row = 0;
    if (token.type === 'th_open' || token.type === 'td_open') row++;
    if (token.type === 'tr_close') tables.push(row);
  }
  const fences = tokens.filter(token => token.type === 'fence');
  return {
    headings: tokens.filter(token => token.type === 'heading_open').map(token => Number(token.tag.slice(1))),
    code: [...fences.filter(token => !isTextFence(token)).map(token => ({ info: token.info.trim(), text: token.content })),
      ...tokens.filter(token => token.type === 'code_block').map(token => ({ info: '', text: token.content }))],
    inlineCode: inline.filter(token => token.type === 'code_inline').map(token => token.content.trim()).sort(),
    textBlocks: fences.filter(isTextFence).map(token => ({ info: token.info.trim() })),
    math: extractDisplayMath(text),
    links: extractLinkTargets(text),
    tables,
    lists: tokens.filter(token => ['bullet_list_open', 'bullet_list_close', 'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close'].includes(token.type)).map(token => ({ type: token.type, level: token.level })),
    quotes: tokens.filter(token => token.type === 'blockquote_open' || token.type === 'blockquote_close').map(token => ({ type: token.type, level: token.level }))
  };
}

function headingIds(markdown) {
  const tokens = parseTokens(markdown);
  const $ = load(md.renderer.render(tokens, md.options, {}), {}, false);
  return $('h1,h2,h3,h4,h5,h6').map((_, element) => $(element).attr('id')).get().filter(Boolean);
}

function headingMap(source, translation) {
  const sourceIds = headingIds(parseFrontMatter(source).body);
  const targetIds = headingIds(parseFrontMatter(translation).body);
  if (!sourceIds.length || sourceIds.length !== targetIds.length) return {};
  return Object.fromEntries(sourceIds.map((id, index) => [id, targetIds[index]]));
}

module.exports = { parseFrontMatter, parseTokens, parseSections, documentSections, hashText, hashSection, normalizeNewlines, isTextFence, isTranslatableFence, extractFencedCode, extractDisplayMath, extractLinkTargets, mathKey, structureSignature, headingIds, headingMap };
