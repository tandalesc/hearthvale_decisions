// Account state is server supplied. Unknown and offline sessions use the free tier.
export const isPaid = (session) => session?.tier === 'paid';
export const allowedSpeeds = (session) => isPaid(session) ? [1, 3, 5, 10, 20] : [1, 3, 5];
export function entitledSpeed(speed, session) {
  if (speed === 0) return 0;
  return allowedSpeeds(session).includes(speed) ? speed : 1;
}
export async function loadEntitlement(fetcher = globalThis.fetch) {
  try {
    const response = await fetcher('/api/session', {credentials: 'same-origin', signal: AbortSignal.timeout(5000)});
    if (response.ok) {
      const session = await response.json();
      return {...session, tier: isPaid(session) ? 'paid' : 'free'};
    }
  } catch { /* offline play uses local rules */ }
  return {tier: 'free', authenticated: false, billingEnabled: false};
}
