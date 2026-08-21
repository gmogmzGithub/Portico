export function ansiToHtml(text) {
  const ansiRegex = /\x1b\[([0-9;]+)m/g;
  let html = text;

  const ansiMap = {
    '0': '</span>',
    '1': '<span class="ansi-bold">',
    '2': '<span class="ansi-dim">',
    '3': '<span class="ansi-italic">',
    '4': '<span class="ansi-underline">',
    '30': '<span class="ansi-black">',
    '31': '<span class="ansi-red">',
    '32': '<span class="ansi-green">',
    '33': '<span class="ansi-yellow">',
    '34': '<span class="ansi-blue">',
    '35': '<span class="ansi-magenta">',
    '36': '<span class="ansi-cyan">',
    '37': '<span class="ansi-white">',
    '90': '<span class="ansi-bright-black">',
    '91': '<span class="ansi-bright-red">',
    '92': '<span class="ansi-bright-green">',
    '93': '<span class="ansi-bright-yellow">',
    '94': '<span class="ansi-bright-blue">',
    '95': '<span class="ansi-bright-magenta">',
    '96': '<span class="ansi-bright-cyan">',
    '97': '<span class="ansi-bright-white">'
  };

  html = html.replace(ansiRegex, (match, codes) => {
    const codeList = codes.split(';');
    let result = '';
    for (const code of codeList) {
      if (ansiMap[code]) {
        result += ansiMap[code];
      }
    }
    return result || '';
  });

  // Escape HTML special characters
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Re-enable our span tags
  html = html
    .replace(/&lt;span class="([^"]+)"&gt;/g, '<span class="$1">')
    .replace(/&lt;\/span&gt;/g, '</span>');

  return html;
}
