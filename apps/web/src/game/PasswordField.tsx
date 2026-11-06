import { useEffect, useId, useState } from 'react';

interface Props {
  label?: string;
  name?: string;
  autoComplete: 'current-password' | 'new-password';
  disabled: boolean;
  active?: boolean;
  placeholder?: string;
}

export function credentialError(username: string, password: string) {
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username.normalize('NFKC'))) return '用户名须为 3～32 位字母、数字或下划线。';
  if (password.length < 12 || password.length > 128) return '密码长度须为 12～128 个字符。';
  return '';
}

export default function PasswordField({ label = '密码', name = 'password', autoComplete, disabled, active = true, placeholder }: Props) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (!active) setVisible(false); }, [active]);
  const reveal = active && visible;
  return <div className="bag-password">
    <label htmlFor={id}>{label}</label>
    <div className="bag-password-input">
      <input id={id} name={name} type={reveal ? 'text' : 'password'} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false} required disabled={disabled} placeholder={placeholder} />
      <button className="bag-password-toggle" type="button" aria-label={label + '可见'} aria-controls={id} aria-pressed={reveal} title={(reveal ? '隐藏' : '显示') + label} disabled={disabled} onClick={() => setVisible(value => !value)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.5" />
          {reveal && <path d="m4 4 16 16" />}
        </svg>
      </button>
    </div>
  </div>;
}
