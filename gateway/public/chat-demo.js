// chat-demo.js: a pretend chat site for testing the extension (no real AI).
// It is its own file (not an inline <script>) because the gateway's security
// headers only allow scripts loaded from files on this site (Phase 10).

const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const serverLog = document.getElementById('server-log');

function bubble(role, text) {
  const div = document.createElement('div');
  div.className = 'bubble';
  div.setAttribute('data-message-author-role', role);
  div.textContent = text;
  messages.append(div);
  messages.scrollTop = messages.scrollHeight;
}

function send() {
  const text = composer.innerText.trim();
  if (!text) return;
  composer.textContent = '';

  // 1. What the server receives (shown as-is, never restored)
  if (serverLog.querySelector('p')) serverLog.textContent = '';
  const pre = document.createElement('pre');
  pre.textContent = text;
  serverLog.prepend(pre);

  // 2. The user's message in the chat
  bubble('user', text);

  // 3. A pretend AI reply that refers to whatever tags/values it received
  setTimeout(() => {
    const tags = text.match(/\[\[[A-Z_]+_\d+\]\]/g);
    bubble('assistant', tags
      ? `Sure! I've drafted the reply for ${[...new Set(tags)].join(', ')}. Let me know if anything should change.`
      : `Sure! Here's my answer to: "${text.slice(0, 80)}"`);
  }, 600);
}

document.getElementById('send').addEventListener('click', send);
composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
