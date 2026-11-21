import { t, useLanguage } from '../i18n';
import React, { useCallback, useEffect, useState } from 'react';
import { Globe } from './icons';
import { notifyMediaSourcesChanged } from './useMediaSources';
import './CustomSources.css';

/**
 * 第三方来源脚本开关。
 * 默认全部关闭；勾选后才会出现在发现页与搜索的来源列表里。
 * 成人来源额外标注，需用户主动勾选。
 */
export default function ModuleSources({ active = true }) {
  useLanguage();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await window.electronAPI.getModuleSources?.();
      if (!result?.success) throw new Error(result?.error || '第三方来源加载失败');
      setSources(result.sources || []);
    } catch (cause) { setError(cause.message || '第三方来源加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (active) load(); }, [active, load]);

  const toggle = async (id, enabled) => {
    if (saving) return;
    setSaving(id); setError(''); setNotice('');
    try {
      const result = await window.electronAPI.setModuleSourceEnabled?.(id, enabled);
      if (!result?.success) throw new Error(result?.error || '保存失败，请重试');
      setSources(current => current.map(source => source.id === id ? { ...source, enabled } : source));
      setNotice(enabled ? `已开启 ${sources.find(source => source.id === id)?.label || id}，可在发现页与搜索中选择` : '已关闭，发现页与搜索不再显示该来源');
      notifyMediaSourcesChanged();
    } catch (cause) { setError(cause.message || '保存失败，请重试'); }
    finally { setSaving(''); }
  };

  const enabledCount = sources.filter(source => source.enabled).length;

  return <section className="settings-card builtin-sources" aria-labelledby="module-sources-title">
    <div className="custom-sources-heading"><Globe size={18} /><h3 id="module-sources-title">{t('第三方来源')}</h3></div>
    <p className="settings-hint" id="module-sources-hint">{t('应用内置的第三方来源脚本，默认关闭。勾选后才会出现在发现页与搜索的来源列表中；来源内容由第三方站点提供，可用性随站点变化。')}</p>
    {loading && <p className="settings-hint" role="status">{t('正在读取来源…')}</p>}
    {error && <p className="appearance-error" role="alert">{t(error)}</p>}
    {!loading && !sources.length && <p className="settings-hint">{t('未找到可用的第三方来源脚本。')}</p>}
    {sources.map(source => <label className="builtin-source-row" key={source.id}>
      <span>
        {source.label}
        {source.adult ? <em>{t('成人内容')}</em> : <em>{source.enabled ? t('已开启') : t('已关闭')}</em>}
      </span>
      <input type="checkbox" role="switch" aria-label={source.label} aria-describedby="module-sources-hint"
        checked={source.enabled === true} disabled={loading || !!saving}
        onChange={event => toggle(source.id, event.target.checked)} />
    </label>)}
    {!loading && sources.length > 0 && <p className="settings-hint">{t('已开启 ')}{enabledCount}{t(' 个第三方来源。')}</p>}
    {notice && <p className="settings-hint" role="status">{t(notice)}</p>}
    {!loading && !!error && <button type="button" className="btn btn-outline btn-sm" onClick={load}>{t('重新读取')}</button>}
  </section>;
}
