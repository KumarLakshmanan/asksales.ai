import {render,screen} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {YouTubeStudioPanel} from '@/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{get:mocks.get,post:mocks.post}}));
beforeEach(()=>{sessionStorage.clear();vi.clearAllMocks();mocks.get.mockImplementation(async(path:string)=>path.includes('channel-accounts')?[{id:11,accountName:'Synthetic channel',accountIdentifier:'synthetic-channel',isSelected:true}]:{ready:true});});
describe('YouTube management persistent accessible labels',()=>{
 it.each([['combobox','Video privacy'],['combobox','Playlist'],['textbox','Chapters'],['textbox','Caption language']])('names the %s control %s',async(role,name)=>{
  render(<YouTubeStudioPanel/>);const control=await screen.findByRole(role,{name});expect(control).toHaveAccessibleName(name);expect(screen.getByText(name,{selector:'label'})).toBeVisible();expect(mocks.post).not.toHaveBeenCalled();
 });
});
