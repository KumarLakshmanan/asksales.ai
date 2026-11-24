"use client";

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useHydrated } from '@/hooks/use-hydrated';
import {
  ArrowLeft, ArrowRight, RotateCcw, Check, UserRound, Clapperboard,
  UsersRound, TrendingUp, Building2, BriefcaseBusiness, Search, Send,
  PencilRuler, ChartNoAxesCombined,
} from 'lucide-react';
import {
  FINDER_QUESTIONS, recommendPlan, formatCredits, formatRupees,
  type BillingTerm, type FinderAnswers, type SubscriptionPlan,
} from '../../../../shared/subscriptions';

const stepLabels = ['About you', 'Your focus', 'Lead volume', 'Outreach', 'Creation'];
const choiceIcons = {
  customer: [UserRound, Clapperboard, UsersRound, TrendingUp, Building2, BriefcaseBusiness],
  workflow: [Search, Send, PencilRuler, ChartNoAxesCombined],
};
const volumeSteps = ['≤100', '101–500', '501–2k', '2k–10k', '10k+'];
const initialAnswers = (): FinderAnswers => FINDER_QUESTIONS.map(question =>
  question.id === 'leads' || question.id === 'outreach' ? [0] : []);
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40';

export default function PlanFinder({ term, plans }: { term: BillingTerm; plans: SubscriptionPlan[] }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<FinderAnswers>(initialAnswers);
  const title = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const hydrated = useHydrated();
  const question = FINDER_QUESTIONS[step];
  const result = step === FINDER_QUESTIONS.length ? recommendPlan(answers, plans) : null;
  const selected = answers[step] ?? [];
  const multiple = question?.selection === 'multiple';
  const volume = question?.id === 'leads' || question?.id === 'outreach';

  useLayoutEffect(() => {
    if (navigated.current) {
      title.current?.focus({ preventScroll: true });
      title.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [step]);

  const move = (next: number) => {
    navigated.current = true;
    setStep(next);
  };
  const choose = (index: number) => setAnswers(previous => {
    const next = [...previous];
    const current = next[step] ?? [];
    next[step] = multiple
      ? current.includes(index) ? current.filter(value => value !== index) : [...current, index]
      : [index];
    return next;
  });

  return (
    <section id="plan-finder" aria-labelledby="finder-heading" className="scroll-mt-24 border-y border-border bg-muted/30 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium text-primary">Plan finder · about 60 seconds</p>
          <h2 id="finder-heading" className="mt-4 text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">Find your starting point.</h2>
          <p className="mt-5 text-base leading-7 text-muted-foreground">Tell us about your work. We’ll help you choose a monthly credit allowance.</p>
        </div>

        <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div role="progressbar" aria-label="Plan finder progress" aria-valuemin={0} aria-valuemax={5} aria-valuenow={step} aria-valuetext={result ? 'All five questions complete' : `Step ${step + 1} of 5`} className="border-b border-border px-5 py-5 sm:px-10">
            <ol aria-hidden="true" className="grid grid-cols-5 gap-2 sm:gap-4">
              {stepLabels.map((label, index) => (
                <li key={label} className="min-w-0">
                  <div className={`mb-3 h-1 rounded-full ${index <= step ? 'bg-primary' : 'bg-muted'}`} />
                  <span className={`flex items-center gap-2 text-xs sm:text-sm ${index === step ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${index < step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                      {index < step ? <Check className="h-3 w-3" /> : index + 1}
                    </span>
                    <span className="hidden sm:inline">{label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="p-5 sm:p-10 lg:px-12 lg:py-10">
            <p className="font-mono text-xs text-muted-foreground">{result ? 'Your recommendation' : `Question ${step + 1} of 5`}</p>
            <h3 ref={title} tabIndex={-1} className="mt-3 scroll-mt-24 text-2xl font-semibold tracking-tight outline-none sm:text-3xl">{result ? `${result.plan.name} looks like a good starting point.` : question.title}</h3>
            {result ? (
              <>
                <p className="mt-5 text-lg"><strong>{formatRupees(term === 'monthly' ? result.plan.monthlyRupees : result.plan.yearlyRupees)}</strong><span className="text-muted-foreground"> / {term === 'monthly' ? 'month' : 'year'} · </span><strong>{formatCredits(result.plan.monthlyCredits)}</strong><span className="text-muted-foreground"> credits each month</span></p>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">This is a guide based on your answers, not a usage quote. Actual credit costs depend on your actions, models and providers. {term === 'yearly' ? 'Yearly payment is upfront; credits arrive monthly.' : 'Payment renews monthly.'}</p>
                <h4 className="mt-7 text-sm font-semibold">What shaped your recommendation</h4>
                <ul className="mt-4 grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2">
                  {result.choices.map(choice => <li key={choice.question} className="flex gap-3"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden /><span className="leading-6"><span className="block text-xs text-muted-foreground">{choice.question}</span>{choice.label}</span></li>)}
                </ul>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                  <Link className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} href={`/subscribe?plan=${result.plan.slug}&term=${term}&version=${result.plan.version}`}>Choose {result.plan.name}<ArrowRight className="h-4 w-4" aria-hidden /></Link>
                  <a href="#plans" className={`${button} border border-border hover:bg-muted`}>Compare all plans</a>
                  <button type="button" className={`${button} text-muted-foreground hover:text-foreground`} onClick={() => { setAnswers(initialAnswers()); move(0); }}><RotateCcw className="h-4 w-4" aria-hidden />Start again</button>
                </div>
              </>
            ) : (
              <>
                <p id={`finder-hint-${question.id}`} className="mt-3 text-sm leading-6 text-muted-foreground">{question.hint}</p>
                {volume ? (
                  <div className="mt-8 pb-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                      <output htmlFor={`finder-range-${question.id}`} className="text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl">{question.options[selected[0]].label.replace(' messages', '')}</output>
                      <span className="text-sm text-muted-foreground">{question.id === 'leads' ? 'leads' : 'messages'} / month</span>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">Drag to a range, or tap a label below.</p>
                    <input
                      id={`finder-range-${question.id}`} type="range" min={0} max={question.options.length - 1} step={1}
                      value={selected[0]} onChange={event => choose(Number(event.target.value))}
                      aria-label={question.title} aria-valuetext={`${question.options[selected[0]].label}${question.id === 'leads' ? ' leads' : ''} per month`}
                      aria-describedby={`finder-hint-${question.id}`}
                      className="mt-5 block h-11 w-full cursor-pointer rounded-lg accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4"
                    />
                    <div className="grid grid-cols-5 gap-1">
                      {question.options.map((option, index) => (
                        <button key={option.label} type="button" aria-label={`Set ${option.label}`} aria-pressed={selected[0] === index} onClick={() => choose(index)} className={`min-h-11 rounded-lg px-1 text-[11px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:text-sm ${selected[0] === index ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                          {volumeSteps[index]}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mt-7 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-foreground">{multiple ? 'Select all that apply' : 'Select one option'}</span>
                      <span aria-live="polite" className="text-muted-foreground">{selected.length} selected</span>
                    </div>
                    <fieldset key={question.id} disabled={!hydrated} aria-describedby={`finder-hint-${question.id}`} className={`mt-3 grid gap-3 sm:grid-cols-2 ${question.id === 'customer' ? 'lg:grid-cols-3' : ''}`}>
                      <legend className="sr-only">{question.title}</legend>
                      {question.options.map((option, index) => {
                        const checked = selected.includes(index);
                        const Icon = question.id === 'customer' || question.id === 'workflow' ? choiceIcons[question.id][index] : null;
                        return (
                          <label key={option.label} className="block cursor-pointer">
                            <input className="peer sr-only" type={multiple ? 'checkbox' : 'radio'} name={`finder-${question.id}`} value={index} aria-label={option.label} checked={checked} onChange={() => choose(index)} />
                            <span className={`flex h-full min-h-[76px] items-center gap-3 rounded-xl border px-4 py-4 text-sm transition-colors motion-reduce:transition-none peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card ${checked ? 'border-primary bg-primary/5 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]' : 'border-border bg-background/40 text-foreground hover:border-primary/50 hover:bg-muted/40'}`}>
                              {Icon && <Icon className={`h-5 w-5 shrink-0 ${checked ? 'text-primary' : 'text-muted-foreground'}`} strokeWidth={1.7} aria-hidden />}
                              <span className="flex-1 font-medium leading-5">{option.label}</span>
                              <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center border ${multiple ? 'rounded-md' : 'rounded-full'} ${checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-card'}`}>
                                {checked && (multiple ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <span className="h-2 w-2 rounded-full bg-primary-foreground" />)}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </fieldset>
                  </>
                )}
                <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-6">
                  <button type="button" className={`${button} border border-border hover:bg-muted`} disabled={step === 0} onClick={() => move(step - 1)}><ArrowLeft className="h-4 w-4" aria-hidden />Back</button>
                  <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!selected.length} onClick={() => move(step + 1)}>{step === 4 ? 'See my plan' : 'Continue'}<ArrowRight className="h-4 w-4" aria-hidden /></button>
                </div>
              </>
            )}
          </div>
        </div>
        <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">Your answers stay in this browser and are cleared when you leave or restart.</p>
      </div>
    </section>
  );
}
