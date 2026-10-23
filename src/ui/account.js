import {h} from './dom.js';
import './account.css';

const PLAN_KEY = 'hearthvale.plan';
const SIGNIN_KEY = 'hearthvale.pending-signin';
function pendingSignin() {
  try {
    const value = JSON.parse(localStorage.getItem(SIGNIN_KEY));
    if (value?.expires > Date.now() && typeof value.email === 'string' && (value.challenge === null || /^[a-f0-9]{64}$/.test(value.challenge))) return value;
    localStorage.removeItem(SIGNIN_KEY);
  } catch {}
  return null;
}
function rememberSignin(value) {
  try { if (value) localStorage.setItem(SIGNIN_KEY, JSON.stringify(value)); else localStorage.removeItem(SIGNIN_KEY); } catch {}
}

const PLUS_BENEFITS = ['10× and 20× speed', 'Automatic cloud backup for up to 10 towns', 'Live decisions for your townspeople', 'Richer writing in the Council and town notes'];
const benefits = () => h('ul.account-features', null, ...PLUS_BENEFITS.map(text => h('li', null, text)));
const savedPlan = () => { try { return localStorage.getItem(PLAN_KEY) === 'year' ? 'year' : 'month'; } catch { return 'month'; } };

export function createAccount(initialSession) {
  let pending = pendingSignin();
  if (initialSession.authenticated) { pending = null; rememberSignin(null); }
  let session = initialSession, dialog = null, opener = null, interval = savedPlan(), busy = false, refreshView = null;
  function close() { dialog?.close(); }
  function open({view, notice, pendingPayment = false} = {}) {
    if (dialog?.open) { dialog.focus(); return; }
    if (pending?.expires <= Date.now()) { pending = null; rememberSignin(null); }
    opener = document.activeElement;
    dialog = h('dialog.account-paper', {'aria-labelledby': 'account-title'});
    const activeDialog = dialog, activeOpener = opener;
    const content = h('div.account-content');
    const closeButton = h('button.account-close', {type: 'button', 'aria-label': 'Close account', onclick: close}, '×');
    dialog.append(closeButton, content);
    dialog.addEventListener('close', () => { activeDialog.remove(); if (dialog === activeDialog) { dialog = null; refreshView = null; activeOpener?.focus?.(); } });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
    document.body.append(dialog);
    let currentPage = 'signin';
    refreshView = () => render(session.tier === 'paid' ? 'account' : session.authenticated ? (currentPage === 'plans' || currentPage === 'signin' || currentPage === 'sent' ? 'plans' : 'account') : pending ? 'sent' : 'signin', pending?.email || '');
    render(view === 'plans' && session.tier !== 'paid' ? 'plans' : session.authenticated ? 'account' : pending ? 'sent' : 'signin', pending?.email || '');
    dialog.showModal();
    content.querySelector('input, [autofocus], button')?.focus();

    function render(page, emailValue = '') {
      const transitioning = content.childElementCount > 0;
      if (transitioning) queueMicrotask(() => {
        if (activeDialog.open && content.isConnected) content.querySelector(page === 'signin' || page === 'sent' ? 'input' : 'h2')?.focus();
      });
      currentPage = page;
      const status = h('p.account-status', {role: 'status', 'aria-live': 'polite'}, notice || '');
      const title = (name, intro) => [h('h2', {id: 'account-title', tabindex: '-1'}, name), h('p.account-intro', null, intro)];
      const button = (label, fn, primary = false) => h('button.btn', {type: 'button', class: primary ? 'btn-primary' : 'btn-secondary', onclick: fn}, label);
      async function post(path, body) {
        const response = await fetch(path, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        return data;
      }
      async function run(action, label) {
        if (busy) return;
        busy = true; status.textContent = label;
        const controls = [...content.querySelectorAll('button,input')].map(node => [node, node.disabled]);
        controls.forEach(([node]) => node.disabled = true);
        try { await action(); }
        catch (error) { status.textContent = error.message; status.classList.add('is-error'); }
        finally { busy = false; controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; }); }
      }
      content.replaceChildren();
      if (page === 'sent') {
        content.append(...title('Check your email', `We sent a code and sign-in link to ${emailValue}. Enter the code here to stay in this app.`));
        const code = h('input.account-email', {id: 'account-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '12', required: true, placeholder: '123456'});
        code.addEventListener('input', () => { code.value = code.value.replace(/[^0-9]/g, '').slice(0, 6); });
        const form = h('form.account-form', null, h('label', {for: 'account-code'}, '6-digit sign-in code'), code, h('button.btn.btn-primary', {type: 'submit'}, 'Sign in'));
        form.addEventListener('submit', event => {
          event.preventDefault();
          if (!form.reportValidity()) return;
          run(async () => {
            if (!pending) throw new Error('Request a new sign-in email, then enter its code here.');
            await post('/api/auth/code', {...(pending.challenge ? {challenge: pending.challenge} : {email: pending.email}), code: code.value});
            pending = null; rememberSignin(null);
            location.assign('/?signin=success');
          }, 'Signing you in…');
        });
        content.append(form, status, h('p.account-status', null, 'The code and link expire in 15 minutes. Use either one.'), button('Request a new email', () => { pending = null; rememberSignin(null); render('signin', emailValue); }), button('Use a different email', () => { pending = null; rememberSignin(null); render('signin'); }), button('Back to my town', close));
        return;
      }
      if (page === 'signin') {
        content.append(...title('Sign in with email', 'Get a sign-in code and link in your inbox.'));
        const email = h('input.account-email', {id: 'account-email', type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com', value: emailValue});
        const submit = h('button.btn.btn-primary', {type: 'submit'}, 'Send me a sign-in email');
        const form = h('form.account-form', null, h('label', {for: 'account-email'}, 'Email address'), email, submit);
        form.addEventListener('submit', (event) => { event.preventDefault(); if (!form.reportValidity()) return; run(async () => { const result = await post('/api/auth/email', {email: email.value.trim()}); pending = {email: email.value.trim(), challenge: result.challenge, expires: Date.now() + 900000}; rememberSignin(pending); render('sent', pending.email); }, 'Sending your email…'); });
        content.append(form, status, button('I already have a code', () => {
          if (!email.reportValidity()) return;
          pending = {email: email.value.trim(), challenge: null, expires: Date.now() + 900000};
          rememberSignin(pending); render('sent', pending.email);
        }), button('Explore Hearthvale Plus', () => render('plans')));
        return;
      }
      if (page === 'plans') {
        content.append(...title('Hearthvale Plus', 'More room to follow your town as it grows.'));
        content.append(benefits());
        const billingTerms = h('p.account-status', null, interval === 'year' ? '$10 billed yearly. Renews automatically. Cancel anytime.' : '$1 billed monthly. Renews automatically. Cancel anytime.');
        const plans = h('div.account-plans', {role: 'group', 'aria-label': 'Choose a plan'});
        for (const [value, price, caption] of [['month', '$1', 'per month'], ['year', '$10', 'per year · save $2']]) {
          const plan = h('button.account-plan', {type: 'button', 'aria-pressed': String(value === interval), onclick: () => { interval = value; billingTerms.textContent = value === 'year' ? '$10 billed yearly. Renews automatically. Cancel anytime.' : '$1 billed monthly. Renews automatically. Cancel anytime.'; try { localStorage.setItem(PLAN_KEY, value); } catch {} for (const node of plans.children) node.setAttribute('aria-pressed', String(node === plan)); }}, h('b', null, price), h('span', null, caption));
          plans.append(plan);
        }
        const checkout = button(session.authenticated ? 'Continue to checkout' : 'Sign in to continue', () => {
          if (!session.authenticated) { render('signin'); content.querySelector('input')?.focus(); return; }
          run(async () => { const result = await post('/api/billing/checkout', {interval}); location.assign(result.url); }, 'Opening checkout…');
        }, true);
        if (session.authenticated && !session.billingEnabled) { checkout.disabled = true; status.textContent = 'Subscriptions are not available just yet. You can keep playing for free.'; }
        content.append(plans, billingTerms, checkout, status);
        if (session.authenticated && pendingPayment) content.append(button('Refresh access', () => run(async () => {
          const response = await fetch('/api/session', {credentials: 'same-origin', cache: 'no-store'});
          if (!response.ok) throw new Error('We could not check your plan. Please try again.');
          const fresh = await response.json();
          if (fresh.authenticated && fresh.tier === 'paid') { location.reload(); return; }
          status.textContent = 'Your payment is still being confirmed. Give it a moment, then refresh access again.';
        }, 'Checking your plan…')));
        content.append(button('Keep playing for free', close));
        return;
      }
      const paid = session.tier === 'paid';
      content.append(...title(paid ? 'Hearthvale Plus' : 'Make yourself at home', session.email || 'You are signed in.'));
      if (paid) {
        content.append(h('p', null, 'Your current tier: Hearthvale Plus.'), benefits());
        if (session.billingEnabled) content.append(button('Manage subscription', () => run(async () => location.assign((await post('/api/billing/portal', {})).url), 'Opening your subscription…'), true));
      } else content.append(h('p', null, 'You can keep playing for free, or give your town a little more with Plus.'), button('Explore Hearthvale Plus', () => render('plans'), true));
      content.append(button('Sign out', () => run(async () => { await post('/api/logout', {}); location.reload(); }, 'Signing out…')), status);
    }
  }
  return {open, close, update(next) { const changed = session.authenticated !== next.authenticated || session.tier !== next.tier; session = next; if (next.authenticated) { pending = null; rememberSignin(null); } if (changed && dialog?.open) refreshView?.(); }};
}

// A normal entry button for surfaces that want to mount one directly.
export function mountAccount(session, {container = document.body} = {}) {
  const account = createAccount(session);
  const button = h('button.btn.btn-secondary.account-entry', {type: 'button', onclick: () => account.open()}, session.authenticated ? 'Manage account' : 'Sign in');
  container.append(button);
  return button;
}
