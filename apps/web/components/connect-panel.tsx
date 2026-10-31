'use client';

import { useEffect, useState } from 'react';
import { Cloud, Info, LoaderCircle, Send, ShieldCheck, Check, Archive, KeyRound, ExternalLink } from 'lucide-react';
import { APIError, ServerGateway, type AuthState } from '@/lib/server';
import { telegramGateway, type TelegramAuthState } from '@/lib/telegram-client';

export default function ConnectPanel({gateway,serverMode,locale,onConnected}: {
  gateway:ServerGateway;serverMode:boolean;locale:'en'|'bn';onConnected:()=>Promise<void>;
}) {
  const [state,setState]=useState<AuthState|TelegramAuthState|null>(null);
  const [phone,setPhone]=useState('');
  const [stepValue,setStepValue]=useState('');
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [retryUntil,setRetryUntil]=useState(0);
  const [remaining,setRemaining]=useState(0);

  // Direct client credentials state
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [configuringCreds, setConfiguringCreds] = useState(false);

  const t=(en:string,bn:string)=>locale==='bn'?bn:en;
  const phase=state?.state||'phone_required';

  const fail=(value:unknown)=>{
    setError(value instanceof Error?value.message:t('Connection is unavailable. Please try again.','সংযোগ পাওয়া যাচ্ছে না। আবার চেষ্টা করুন।'));
    if(value instanceof APIError&&value.status===401){setState({state:'phone_required'});setStepValue('');}
    if(value instanceof APIError&&value.retryAfterSeconds)setRetryUntil(Date.now()+value.retryAfterSeconds*1000);
  };

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      if (serverMode) {
        await gateway.bootstrap();
        const current=await gateway.authState();
        if(!cancelled)setState(current);
      } else {
        const creds = telegramGateway.getApiCredentials();
        if (!creds) {
          setState({state:'credentials_required'});
          return;
        }
        const current = await telegramGateway.authState();
        if (!cancelled) setState(current);
      }
    })().catch(value=>{if(!cancelled&&!(value instanceof APIError&&value.status===401))fail(value);});
    return()=>{cancelled=true;};
  },[gateway,serverMode]);

  useEffect(()=>{
    if(!retryUntil)return;
    const tick=()=>setRemaining(Math.max(0,Math.ceil((retryUntil-Date.now())/1000)));
    tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);
  },[retryUntil]);

  useEffect(()=>{
    if(serverMode) {
      if(phase!=='connecting'||remaining>0)return;
      let cancelled=false;
      const timer=setInterval(()=>gateway.authState().then(next=>{if(!cancelled){setState(next);}}).catch(value=>{if(!cancelled)fail(value);}),2000);
      return()=>{cancelled=true;clearInterval(timer);};
    }
  },[gateway,serverMode,phase,remaining]);

  const saveCredentials = (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiId || !apiHash) return;
    try {
      telegramGateway.saveApiCredentials(Number(apiId), apiHash.trim());
      setConfiguringCreds(false);
      setState({ state: 'phone_required' });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    }
  };

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy||remaining>0)return;
    setBusy(true);setError('');
    try {
      if (serverMode) {
        const next=phase==='code_required'||phase==='password_required'
          ?await gateway.authStep(phase==='password_required'?'password':'code',stepValue)
          :await gateway.authStart(phone,consent);
        setState(next);
      } else {
        if (phase === 'code_required' || phase === 'password_required') {
          const next = await telegramGateway.authStep(phase === 'password_required' ? 'password' : 'code', stepValue);
          setState(next);
          if (next.state === 'ready') {
            await onConnected();
          }
        } else {
          const next = await telegramGateway.authStart(phone, consent);
          setState(next);
        }
      }
    }catch(value){fail(value);}
    finally{setBusy(false);setPhone('');setStepValue('');}
  };

  const chooseStorage=async()=>{
    setBusy(true);setError('');
    try{
      if (serverMode) {
        await gateway.me();
        await gateway.selectStorage();
      } else {
        telegramGateway.selectStorage('me');
      }
      await onConnected();
    }
    catch(value){fail(value);}finally{setBusy(false);}
  };

  return <div>
    <div className="connect-illustration"><Send size={32}/><span>+</span><Cloud size={36}/></div>
    <p className="modal-description">{t('filedeck.ai is an independent third-party Telegram client. Connect your own account to organize original files in a storage chat you select.','filedeck.ai একটি স্বতন্ত্র তৃতীয় পক্ষের টেলিগ্রাম ক্লায়েন্ট। নিজের অ্যাকাউন্টের নির্বাচিত স্টোরেজ চ্যাটে মূল ফাইল গুছিয়ে রাখুন।')}</p>
    <div className="disclosure"><ShieldCheck size={21}/><div><strong>{t('Zero-Cost & Pure Client Privacy','জিরো-কস্ট ও গোপনীয়তা')}</strong><p>{t('Browser mode connects directly from your device to Telegram via WebSockets. Your files and session keys never touch any intermediary server.','ব্রাউজার মোড আপনার ডিভাইস থেকে সরাসরি টেলিগ্রাম সার্ভারে যুক্ত হয়। আপনার ফাইল ও সেশন কোনো মধ্যবর্তী সার্ভারে যায় না।')}</p></div></div>

    {phase==='credentials_required' || configuringCreds ? (
      <form onSubmit={saveCredentials} autoComplete="off">
        <div className="local-notice"><KeyRound size={17}/>{t('To connect Telegram directly from your browser, enter your free API keys from my.telegram.org:','ব্রাউজার থেকে সরাসরি টেলিগ্রাম কানেক্ট করতে my.telegram.org থেকে আপনার ফ্রি API কি দিন:')}</div>
        <p className="fine-print">
          1. Go to <a href="https://my.telegram.org" target="_blank" rel="noreferrer" style={{textDecoration:'underline'}}>my.telegram.org</a> and log in.<br/>
          2. Click <strong>API development tools</strong> and create a client.<br/>
          3. Copy your <strong>App api_id</strong> and <strong>App api_hash</strong> below.
        </p>
        <label className="field-label">{t('Telegram API ID','টেলিগ্রাম API ID')}
          <input value={apiId} onChange={e=>setApiId(e.target.value)} type="number" placeholder="e.g. 12345678" required autoFocus/>
        </label>
        <label className="field-label">{t('Telegram API Hash','টেলিগ্রাম API Hash')}
          <input value={apiHash} onChange={e=>setApiHash(e.target.value)} type="text" placeholder="e.g. 0123456789abcdef..." required/>
        </label>
        <button className="button primary full-width" type="submit">
          <Check size={17}/> {t('Save and Continue','সংরক্ষণ করে এগিয়ে যান')}
        </button>
      </form>
    ) : phase==='ready' ? (
      <div className="storage-selection">
        <div className="local-notice"><Check size={17}/>{t('Telegram connected. Choose where your originals should go.','টেলিগ্রাম যুক্ত হয়েছে। মূল ফাইল কোথায় রাখবেন বেছে নিন।')}</div>
        <div className="storage-choice"><Archive size={24}/><div><strong>{t('Saved Messages','Saved Messages')}</strong><p>{t('A private chat with yourself. Virtual folders stay in your filedeck.ai catalog; they do not create Telegram groups.','নিজের সাথে ব্যক্তিগত চ্যাট। ভার্চুয়াল ফোল্ডার filedeck.ai ক্যাটালগে থাকে, নতুন টেলিগ্রাম গ্রুপ তৈরি করে না।')}</p></div></div>
        <button className="button primary full-width" onClick={chooseStorage} disabled={busy}>{busy?<LoaderCircle size={17} className="spin"/>:<Check size={17}/>} {t('Use Saved Messages','Saved Messages ব্যবহার করুন')}</button>
      </div>
    ) : phase==='connecting' ? (
      <div className="auth-connecting"><LoaderCircle size={28} className="spin"/><p>{t('Waiting for Telegram’s next step…','টেলিগ্রামের পরবর্তী ধাপের অপেক্ষায়…')}</p></div>
    ) : (
      <form onSubmit={submit} autoComplete="off">
        {phase==='code_required' ? (
          <>
            <p className="modal-description">{state?.delivery||state?.hint||t('Enter the code sent by Telegram. It may arrive in the Telegram app rather than by SMS.','টেলিগ্রামের পাঠানো কোড লিখুন। এটি SMS-এর বদলে টেলিগ্রাম অ্যাপে আসতে পারে।')}</p>
            <label className="field-label">{t('Verification code','যাচাইয়ের কোড')}
              <input aria-label={t('Verification code','যাচাইয়ের কোড')} inputMode="numeric" autoComplete="one-time-code" value={stepValue} onChange={event=>setStepValue(event.target.value)} maxLength={32} required autoFocus/>
            </label>
          </>
        ) : phase==='password_required' ? (
          <>
            <p className="modal-description">{state?.hint||t('Telegram requested your two-step verification password.','টেলিগ্রাম আপনার টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড চেয়েছে।')}</p>
            <label className="field-label">{t('Two-step verification password','টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড')}
              <input aria-label={t('Two-step verification password','টু-স্টেপ ভেরিফিকেশন পাসওয়ার্ড')} type="password" autoComplete="off" value={stepValue} onChange={event=>setStepValue(event.target.value)} required autoFocus/>
            </label>
          </>
        ) : (
          <>
            <label className="field-label">{t('Phone number with country code','দেশের কোডসহ ফোন নম্বর')}
              <input value={phone} onChange={event=>setPhone(event.target.value)} type="tel" placeholder="+880 1XXX XXXXXX" pattern="\+[0-9\s\-]{7,20}" required autoComplete="tel"/>
            </label>
            <label className="consent-label">
              <input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>
              <span>{t('I understand my files will be stored in my Telegram account.','আমি বুঝেছি আমার ফাইলগুলো আমার টেলিগ্রাম অ্যাকাউন্টে সংরক্ষিত হবে।')}</span>
            </label>
          </>
        )}
        <button className="button primary full-width" disabled={busy||remaining>0||(!(phase==='code_required'||phase==='password_required')&&!consent)}>
          {busy?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>} {phase==='code_required'||phase==='password_required'?t('Verify and continue','যাচাই করে এগিয়ে যান'):t('Continue with Telegram','টেলিগ্রামের মাধ্যমে এগিয়ে যান')}
        </button>
        {(phase==='code_required'||phase==='password_required')&&(
          <button type="button" className="text-button auth-start-over" onClick={()=>{setState({state:'phone_required'});setStepValue('');setError('');}}>
            {t('Start again with a phone number','ফোন নম্বর দিয়ে আবার শুরু করুন')}
          </button>
        )}
        {!serverMode && (
          <button type="button" className="text-button" style={{marginTop:'8px',fontSize:'12px',opacity:0.8}} onClick={()=>setConfiguringCreds(true)}>
            {t('Change API ID & Hash','API ID ও Hash পরিবর্তন করুন')}
          </button>
        )}
      </form>
    )}
    {remaining>0&&<p className="local-notice" role="status">{t(`Telegram asked us to wait. Try again in ${remaining} seconds.`,`টেলিগ্রাম অপেক্ষা করতে বলেছে। ${remaining} সেকেন্ড পর চেষ্টা করুন।`)}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
