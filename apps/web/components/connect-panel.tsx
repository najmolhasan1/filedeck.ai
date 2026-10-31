'use client';

import { useEffect, useState } from 'react';
import { Cloud, Info, LoaderCircle, Send, ShieldCheck, Check, Archive } from 'lucide-react';
import { APIError, ServerGateway, type AuthState } from '@/lib/server';

export default function ConnectPanel({gateway,serverMode,locale,onConnected}: {
  gateway:ServerGateway;serverMode:boolean;locale:'en'|'bn';onConnected:()=>Promise<void>;
}) {
  const [state,setState]=useState<AuthState|null>(null);
  const [phone,setPhone]=useState('');
  const [stepValue,setStepValue]=useState('');
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [retryUntil,setRetryUntil]=useState(0);
  const [remaining,setRemaining]=useState(0);
  const t=(en:string,bn:string)=>locale==='bn'?bn:en;
  const phase=state?.state||'phone_required';
  const fail=(value:unknown)=>{
    setError(value instanceof Error?value.message:t('Connection is unavailable. Please try again.','সংযোগ পাওয়া যাচ্ছে না। আবার চেষ্টা করুন।'));
    if(value instanceof APIError&&value.status===401){setState({state:'phone_required'});setStepValue('');}
    if(value instanceof APIError&&value.retryAfterSeconds)setRetryUntil(Date.now()+value.retryAfterSeconds*1000);
  };
  useEffect(()=>{
    if(!serverMode)return;let cancelled=false;
    (async()=>{await gateway.bootstrap();const current=await gateway.authState();if(!cancelled)setState(current);})().catch(value=>{if(!cancelled&&!(value instanceof APIError&&value.status===401))fail(value);});
    return()=>{cancelled=true;};
  // Gateway instance is stable for the life of the drive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[gateway,serverMode]);
  useEffect(()=>{
    if(!retryUntil)return;
    const tick=()=>setRemaining(Math.max(0,Math.ceil((retryUntil-Date.now())/1000)));
    tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);
  },[retryUntil]);
  useEffect(()=>{
    if(!serverMode||phase!=='connecting'||remaining>0)return;
    let cancelled=false;
    const timer=setInterval(()=>gateway.authState().then(next=>{if(!cancelled){setState(next);}}).catch(value=>{if(!cancelled)fail(value);}),2000);
    return()=>{cancelled=true;clearInterval(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[gateway,serverMode,phase,remaining]);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!serverMode||busy||remaining>0)return;
    setBusy(true);setError('');
    try {
      const next=phase==='code_required'||phase==='password_required'
        ?await gateway.authStep(phase==='password_required'?'password':'code',stepValue)
        :await gateway.authStart(phone,consent);
      setState(next);

    }catch(value){fail(value);}
    finally{setBusy(false);setPhone('');setStepValue('');}
  };
  const chooseStorage=async()=>{
    setBusy(true);setError('');
    try{await gateway.me();await gateway.selectStorage();await onConnected();}
    catch(value){fail(value);}finally{setBusy(false);}
  };
  return <div>
    <div className="connect-illustration"><Send size={32}/><span>+</span><Cloud size={36}/></div>
    <p className="modal-description">{t('CloudNest is an independent third-party Telegram client. Connect your own account to organize original files in a storage chat you select.','CloudNest একটি স্বতন্ত্র তৃতীয় পক্ষের টেলিগ্রাম ক্লায়েন্ট। নিজের অ্যাকাউন্টের নির্বাচিত স্টোরেজ চ্যাটে মূল ফাইল গুছিয়ে রাখুন।')}</p>
    <div className="disclosure"><ShieldCheck size={21}/><div><strong>{t('Know what you’re connecting','সংযুক্ত করার আগে জানুন')}</strong><p>{t('Web access gives this service a Telegram account session. Its technical access is broader than the storage chats you select. Ordinary Telegram cloud messages are not end-to-end encrypted. We never store your login code or 2FA password.','ওয়েব অ্যাক্সেস সেবাকে একটি টেলিগ্রাম সেশন দেয়। এর প্রযুক্তিগত পরিধি নির্বাচিত চ্যাটের চেয়ে বিস্তৃত। সাধারণ ক্লাউড মেসেজ এন্ড-টু-এন্ড এনক্রিপ্টেড নয়। লগইন কোড বা 2FA পাসওয়ার্ড সেভ করা হয় না।')}</p></div></div>
    {!serverMode?<div className="local-notice"><Info size={17}/>{t('This deployment is a browser demo. To connect Telegram, configure the server deployment and enable server storage mode. No login information is collected here.','এটি ব্রাউজার ডেমো। টেলিগ্রাম যুক্ত করতে সার্ভার কনফিগার করে server storage mode চালু করুন। এখানে লগইন তথ্য সংগ্রহ করা হয় না।')}</div>:phase==='ready'?<div className="storage-selection"><div className="local-notice"><Check size={17}/>{t('Telegram connected. Choose where your originals should go.','টেলিগ্রাম যুক্ত হয়েছে। মূল ফাইল কোথায় রাখবেন বেছে নিন।')}</div><div className="storage-choice"><Archive size={24}/><div><strong>{t('Saved Messages','Saved Messages')}</strong><p>{t('A private chat with yourself. Virtual folders stay in your CloudNest catalog; they do not create Telegram groups.','নিজের সাথে ব্যক্তিগত চ্যাট। ভার্চুয়াল ফোল্ডার CloudNest ক্যাটালগে থাকে, নতুন টেলিগ্রাম গ্রুপ তৈরি করে না।')}</p></div></div><button className="button primary full-width" onClick={chooseStorage} disabled={busy}>{busy?<LoaderCircle size={17} className="spin"/>:<Check size={17}/>} {t('Use Saved Messages','Saved Messages ব্যবহার করুন')}</button></div>:phase==='connecting'?<div className="auth-connecting"><LoaderCircle size={28} className="spin"/><p>{t('Waiting for Telegram’s next step…','টেলিগ্রামের পরবর্তী ধাপের অপেক্ষায়…')}</p></div>:<form onSubmit={submit} autoComplete="off">
      {phase==='code_required'?<><p className="modal-description">{state?.delivery||state?.hint||t('Enter the code sent by Telegram. It may arrive in the Telegram app rather than by SMS.','টেলিগ্রামের পাঠানো কোড লিখুন। এটি SMS-এর বদলে টেলিগ্রাম অ্যাপে আসতে পারে।')}</p><label className="field-label">{t('Verification code','যাচাইয়ের কোড')}<input aria-label={t('Verification code','যাচাইয়ের কোড')} inputMode="numeric" autoComplete="one-time-code" value={stepValue} onChange={event=>setStepValue(event.target.value)} maxLength={32} required autoFocus/></label></>:phase==='password_required'?<><p className="modal-description">{state?.hint||t('Telegram requested your two-step verification password.','টেলিগ্রাম আপনার টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড চেয়েছে।')}</p><label className="field-label">{t('Two-step verification password','টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড')}<input aria-label={t('Two-step verification password','টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড')} type="password" autoComplete="off" value={stepValue} onChange={event=>setStepValue(event.target.value)} required autoFocus/></label></>:<><label className="field-label">{t('Phone number with country code','দেশের কোডসহ ফোন নম্বর')}<input value={phone} onChange={event=>setPhone(event.target.value)} type="tel" placeholder="+880 1XXX XXXXXX" pattern="\+[0-9\s\-]{7,20}" required autoComplete="tel"/></label><label className="consent-label"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>{t('I understand the session access described above.','আমি উপরে বর্ণিত সেশনের অ্যাক্সেস বুঝেছি।')}</span></label></>}
      <button className="button primary full-width" disabled={busy||remaining>0||(!(phase==='code_required'||phase==='password_required')&&!consent)}>{busy?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>} {phase==='code_required'||phase==='password_required'?t('Verify and continue','যাচাই করে এগিয়ে যান'):t('Continue with Telegram','টেলিগ্রামের মাধ্যমে এগিয়ে যান')}</button>
      {(phase==='code_required'||phase==='password_required')&&<button type="button" className="text-button auth-start-over" onClick={()=>{setState({state:'phone_required'});setStepValue('');setError('');}}>{t('Start again with a phone number','ফোন নম্বর দিয়ে আবার শুরু করুন')}</button>}
    </form>}
    {remaining>0&&<p className="local-notice" role="status">{t(`Telegram asked us to wait. Try again in ${remaining} seconds.`,`টেলিগ্রাম অপেক্ষা করতে বলেছে। ${remaining} সেকেন্ড পর চেষ্টা করুন।`)}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {serverMode&&<p className="fine-print">{t('Telegram decides each verification step. Codes and passwords stay only in this form until submitted.','প্রতিটি যাচাইয়ের ধাপ টেলিগ্রাম নির্ধারণ করে। কোড ও পাসওয়ার্ড জমা দেওয়া পর্যন্ত কেবল এই ফর্মে থাকে।')}</p>}
  </div>;
}
