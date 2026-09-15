'use strict';

const form = document.getElementById('login-form');
const errorMessage = document.getElementById('login-error');
const button = document.getElementById('login-button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  errorMessage.hidden = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('access-password').value }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败，请重试。');
    document.getElementById('access-password').value = '';
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.replace(['/site?section=about', '/site?section=projects'].includes(next) ? next : '/');
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
    button.disabled = false;
  }
});
