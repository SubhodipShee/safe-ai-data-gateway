// Sends text to the running gateway's /detect endpoint and shows what was caught.
// Works in any terminal (cmd, PowerShell, Git Bash).
//
// Usage:  npm run try -- "Mail rahul@abc.com, PAN ABCPE1234F"
//
// The gateway only returns positions; the matched text is cut from YOUR input here.
const text = process.argv.slice(2).join(' ');
const port = process.env.PORT || 7000;

if (!text) {
  console.log('Usage: npm run try -- "text to scan"');
  process.exit(1);
}

let res;
try {
  res = await fetch(`http://127.0.0.1:${port}/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
} catch {
  console.log(`Gateway is not running on port ${port}. Start it in another terminal with: npm run dev`);
  process.exit(1);
}

const body = await res.json();
if (!res.ok) {
  console.log(`HTTP ${res.status}:`, body.error);
  process.exit(1);
}

console.log(`Input: ${text}\n`);
if (body.count === 0) {
  console.log('\x1b[32mNothing detected\x1b[0m');
} else {
  for (const f of body.findings) {
    const type = f.label ? `${f.type} (${f.label})` : f.type;
    console.log(`\x1b[33m${type.padEnd(26)}\x1b[0m ${text.slice(f.start, f.end)}`);
  }
  console.log(`\n${body.count} item(s) would be masked`);
}
