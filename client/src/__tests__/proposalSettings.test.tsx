import React from 'react';
import {fireEvent,render,screen,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {ProposalReviewPolicyDialog} from '@/components/proposals/ProposalReviewPolicyDialog';
const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks,ApiError:class extends Error{}}));
const policy={requireReviewBeforeAiSend:true,enabled:false,discountThresholdPct:10,amountThreshold:null,currency:'USD',reviewManualPricing:true,reviewerMemberIds:[]};
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockResolvedValue({policy,reviewers:[]});mocks.put.mockImplementation(async(_path,value)=>value);});
afterEach(cleanup);
describe('optional proposal review settings',()=>{
  it('loads review mode and saves automatic sending without changing risk rules',async()=>{
    render(<ProposalReviewPolicyDialog inline/>);
    const review=await screen.findByRole('radio',{name:/Save AI proposals for human review/});
    expect(review).toBeChecked();fireEvent.click(screen.getByRole('radio',{name:/Allow eligible AI proposals/}));
    expect(screen.getByText(/Automatic sending is enabled/)).toBeInTheDocument();
    const save=screen.getByRole('button',{name:'Save policy'});
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/I understand eligible offers will be sent/}));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(()=>expect(mocks.put).toHaveBeenCalledWith('/api/proposals/review-policy',{...policy,requireReviewBeforeAiSend:false}));
    expect(await screen.findByText('Proposal settings saved.')).toHaveAttribute('role','status');
  });
  it('keeps the default of human review: automatic sending cannot be saved without acknowledgement',async()=>{
    render(<ProposalReviewPolicyDialog inline/>);
    await screen.findByRole('radio',{name:/Save AI proposals for human review/});
    expect(screen.queryByRole('checkbox',{name:/I understand eligible offers/})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio',{name:/Allow eligible AI proposals/}));
    expect(screen.getByRole('button',{name:'Save policy'})).toBeDisabled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('can turn human review back on',async()=>{
    mocks.get.mockResolvedValue({policy:{...policy,requireReviewBeforeAiSend:false},reviewers:[]});
    render(<ProposalReviewPolicyDialog inline/>);fireEvent.click(await screen.findByRole('radio',{name:/Save AI proposals for human review/}));
    fireEvent.click(screen.getByRole('button',{name:'Save policy'}));
    await waitFor(()=>expect(mocks.put).toHaveBeenCalledWith('/api/proposals/review-policy',policy));
  });
  it('does not save fallback defaults if loading fails',async()=>{
    mocks.get.mockRejectedValue(new Error('offline'));render(<ProposalReviewPolicyDialog inline/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('button',{name:'Save policy'})).toBeDisabled();expect(mocks.put).not.toHaveBeenCalled();
  });
  it('retains review for policies saved before this setting existed',async()=>{
    const {requireReviewBeforeAiSend,...legacy}=policy;void requireReviewBeforeAiSend;
    mocks.get.mockResolvedValue({policy:legacy,reviewers:[]});render(<ProposalReviewPolicyDialog inline/>);
    expect(await screen.findByRole('radio',{name:/Save AI proposals for human review/})).toBeChecked();
  });
});
