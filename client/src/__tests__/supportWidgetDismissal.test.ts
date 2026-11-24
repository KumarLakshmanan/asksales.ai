import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestSupportWidgetClose } from '@/lib/support-widget-embed';
import { supportWidgetHostOrigin, SUPPORT_WIDGET_CLOSE_MESSAGE } from '../../../shared/supportWidgetEmbed';

afterEach(() => { vi.restoreAllMocks();window.history.replaceState({},'', '/'); });
describe('widget close requests', () => {
  it.each(['https://customer.example','http://localhost:5555'])('allows exact HTTP(S) host origin %s', value => {
    expect(supportWidgetHostOrigin(value)).toBe(value);
  });
  it.each([null,'null','*','javascript:alert(1)','https://customer.example/path','https://customer.example/','https://user:pass@customer.example','https://customer.example?x=1'])('rejects non-origin target %s', value => {
    expect(supportWidgetHostOrigin(value)).toBeNull();
  });
  it('sends a close command only to the explicit host origin, without session data', () => {
    const postMessage=vi.fn();vi.spyOn(window,'parent','get').mockReturnValue({postMessage} as unknown as Window);
    window.history.replaceState({},'', '/?widgetHostOrigin=https%3A%2F%2Fcustomer.example');
    const event=new KeyboardEvent('keydown',{key:'Escape',cancelable:true});requestSupportWidgetClose(event);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({type:SUPPORT_WIDGET_CLOSE_MESSAGE},'https://customer.example');expect(event.defaultPrevented).toBe(true);
  });
  it('does not intercept Escape in standalone chat', () => {
    const post=vi.spyOn(window,'postMessage');window.history.replaceState({},'', '/?widgetHostOrigin=https%3A%2F%2Fcustomer.example');
    requestSupportWidgetClose(new KeyboardEvent('keydown',{key:'Escape'}));expect(post).not.toHaveBeenCalled();
  });
  it('preserves inline frames, composing input, handled Escape and other keys', () => {
    const postMessage=vi.fn();vi.spyOn(window,'parent','get').mockReturnValue({postMessage} as unknown as Window);
    requestSupportWidgetClose(new KeyboardEvent('keydown',{key:'Escape'}));
    window.history.replaceState({},'', '/?widgetHostOrigin=https%3A%2F%2Fcustomer.example');
    requestSupportWidgetClose(new KeyboardEvent('keydown',{key:'Escape',isComposing:true}));
    const handled=new KeyboardEvent('keydown',{key:'Escape',cancelable:true});handled.preventDefault();requestSupportWidgetClose(handled);
    requestSupportWidgetClose(new KeyboardEvent('keydown',{key:'Enter'}));expect(postMessage).not.toHaveBeenCalled();
  });
});
