export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The browser can deny clipboard access even in a secure context.
    }
  }

  const activeElement = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none';
  (activeElement?.closest('[role="dialog"]') ?? document.body).append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
  }
}
