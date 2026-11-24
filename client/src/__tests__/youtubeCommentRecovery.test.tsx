import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {YouTubeStudioPanel} from '@/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{get:mocks.get,post:mocks.post}}));
beforeEach(()=>{
 vi.clearAllMocks();sessionStorage.clear();localStorage.setItem('user',JSON.stringify({id:991}));sessionStorage.setItem('active-business-profile:991','99');
 mocks.get.mockImplementation(async(path:string)=>path.includes('channel-accounts')?[{id:11,accountName:'Synthetic',accountIdentifier:'synthetic-channel',isSelected:true}]:path.includes('/comments')?{comments:[{id:'synthetic-parent',topLevelCommentId:'synthetic-parent',text:'Synthetic comment'}]}:{ready:true});
});
async function showReply(){await screen.findByRole('button',{name:'Load comments'});fireEvent.change(screen.getByLabelText('Video ID'),{target:{value:'synthetic-video'}});fireEvent.click(screen.getByRole('button',{name:'Load comments'}));return screen.findByPlaceholderText('Reply…');}
describe('YouTube comment intent browser recovery',()=>{
 it('retains the reviewed reply/key after timeout and remount, then clears only a verified receipt',async()=>{
  mocks.post.mockRejectedValueOnce(new Error('Synthetic accepted timeout')).mockResolvedValueOnce({id:'synthetic-reply'});
  const view=render(<YouTubeStudioPanel/>);const input=await showReply();fireEvent.change(input,{target:{value:'Reviewed synthetic reply'}});fireEvent.click(screen.getByRole('button',{name:'Reply'}));await screen.findByText('Synthetic accepted timeout');
  const first=mocks.post.mock.calls[0];expect(first[2]?.headers?.['Idempotency-Key']).toBeTruthy();
  view.unmount();render(<YouTubeStudioPanel/>);expect(await showReply()).toHaveValue('Reviewed synthetic reply');fireEvent.click(screen.getByRole('button',{name:'Reply'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(2));expect(mocks.post.mock.calls[1]).toEqual(first);await waitFor(()=>expect(screen.getByPlaceholderText('Reply…')).toHaveValue(''));
 });
 it('blocks overlapping reply dispatches in the component',async()=>{
  let finish!:(x:{id:string})=>void;mocks.post.mockReturnValue(new Promise(r=>{finish=r;}));render(<YouTubeStudioPanel/>);const input=await showReply();fireEvent.change(input,{target:{value:'Reviewed synthetic reply'}});const button=screen.getByRole('button',{name:'Reply'});fireEvent.click(button);fireEvent.click(button);expect(mocks.post).toHaveBeenCalledTimes(1);finish({id:'synthetic-reply'});await waitFor(()=>expect(input).toHaveValue(''));
 });
 it('does not clear the reviewed reply for an empty success response',async()=>{
  mocks.post.mockResolvedValue({});render(<YouTubeStudioPanel/>);const input=await showReply();fireEvent.change(input,{target:{value:'Reviewed synthetic reply'}});fireEvent.click(screen.getByRole('button',{name:'Reply'}));await waitFor(()=>expect(mocks.post).toHaveBeenCalled());expect(input).toHaveValue('Reviewed synthetic reply');await screen.findByText(/receipt.*unconfirmed/i);
 });
 it('uses a new intent only after a definite provider rejection and an explicit user retry',async()=>{
  mocks.post.mockRejectedValueOnce(Object.assign(new Error('Provider rejected reply'),{data:{code:'YOUTUBE_REPLY_REJECTED'}})).mockResolvedValueOnce({id:'synthetic-reply'});render(<YouTubeStudioPanel/>);const input=await showReply();fireEvent.change(input,{target:{value:'Reviewed synthetic reply'}});fireEvent.click(screen.getByRole('button',{name:'Reply'}));await screen.findByText('Provider rejected reply');expect(input).toHaveValue('Reviewed synthetic reply');fireEvent.click(screen.getByRole('button',{name:'Reply'}));await waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(2));expect(mocks.post.mock.calls[1][2].headers['Idempotency-Key']).not.toBe(mocks.post.mock.calls[0][2].headers['Idempotency-Key']);
 });

});
