import {describe,expect,it,jest} from '@jest/globals';
const execute=jest.fn<any>().mockResolvedValue({rows:[{id:701}]});
const deletion=jest.fn<any>();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute,delete:deletion}}));
const {deleteUserById,runService}=await import('../services/adminUserService.js');
describe('billing owner closure retention conflict',()=>{
 it('returns an actionable conflict before any hard deletion',async()=>{
  await expect(deleteUserById(101)).rejects.toMatchObject({status:409,code:'ACCOUNT_CLOSURE_REVIEW_REQUIRED'});
  const result=await runService(()=>deleteUserById(101));
  expect(result.status).toBe(409);expect(result.body).toMatchObject({message:expect.stringContaining('retained billing records')});
  expect(JSON.stringify(result.body)).toContain('retention review');expect(deletion).not.toHaveBeenCalled();
 });
});
