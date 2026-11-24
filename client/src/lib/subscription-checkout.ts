let checkoutScript: Promise<void> | null = null;
export function loadSubscriptionCheckout() {
  if (typeof window.Razorpay === 'function') return Promise.resolve();
  if (!checkoutScript) checkoutScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    const timer = window.setTimeout(() => { script.remove(); checkoutScript = null; reject(new Error('Checkout took too long to load. Please try again.')); }, 15000);
    script.onload = () => { clearTimeout(timer); if (typeof window.Razorpay === 'function') resolve(); else { checkoutScript = null; reject(new Error('Checkout could not load. Please try again.')); } };
    script.onerror = () => { clearTimeout(timer); script.remove(); checkoutScript = null; reject(new Error('Checkout could not load. Check your connection and try again.')); };
    document.head.appendChild(script);
  });
  return checkoutScript;
}

export const PLAN_INTENT_KEY = 'asksales_subscription_selection';
