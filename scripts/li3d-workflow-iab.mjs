import { Buffer } from 'node:buffer';
import { workflowSteps } from './li3d-workflow.mjs';

/** Use from Codex cua_repl with its selected in-app tab. Each next() is bounded. */
export async function createInAppWorkflow(tab, options) {
  const cdp = await tab.capabilities.get('cdp');
  const send = async (method, params) => {
    if (method === 'Page.navigate') { await tab.goto(params.url); return {}; }
    if (method === 'Page.reload') { await tab.reload(); return {}; }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from(await tab.screenshot({ fullPage: false })).toString('base64') };
    return cdp.send(method, params);
  };
  return workflowSteps(send, options, async ({ selector, files }) => {
    const original = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input||input.disabled)throw new Error('File input unavailable');const style=input.getAttribute('style');input.style.cssText='display:block;position:fixed;top:8px;left:8px;z-index:99999;width:420px;height:40px;background:white';return style;})()`, returnByValue: true,
    });
    if (original.exceptionDetails) throw new Error('Could not expose the existing file input');
    try {
      const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 15_000 });
      pending.catch(() => {});
      await tab.playwright.locator(selector).click();
      await (await pending).setFiles(files);
    } finally {
      await cdp.send('Runtime.evaluate', {
        expression: `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(input){const style=${JSON.stringify(original.result.value)};if(style===null)input.removeAttribute('style');else input.setAttribute('style',style);}return true;})()`, returnByValue: true,
      });
    }
  });
}
