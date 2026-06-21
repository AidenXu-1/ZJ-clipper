import { useEffect, useState } from 'react';
import { T } from '@/utils/strings';
import { loadSettings, saveSettings, newProfileId } from '@/utils/storage';
import { testRest } from '@/utils/rest';
import { DEFAULT_SETTINGS, Settings, VaultProfile } from '@/utils/types';

type FieldKey = keyof Settings['frontmatterFields'];

export function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedMsg, setSavedMsg] = useState('');
  const [testMsg, setTestMsg] = useState(''); // 测试连接结果文案
  const [testId, setTestId] = useState(''); // 该结果属于哪张卡片
  const [testingId, setTestingId] = useState(''); // 正在测试的卡片 id

  useEffect(() => {
    loadSettings().then(setS);
  }, []);

  // 应用主题到设置页本身（弹窗在 App.tsx 应用）
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
  }, [s.theme]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  // 仓库档为单一数据源：每张卡片直接编辑对应档
  function updateProfile(id: string, patch: Partial<VaultProfile>) {
    setS((prev) => ({
      ...prev,
      vaultProfiles: prev.vaultProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }

  function setActiveProfile(id: string) {
    setS((prev) => ({ ...prev, activeProfileId: id }));
  }

  function addProfile() {
    setS((prev) => {
      const id = newProfileId();
      const np: VaultProfile = {
        id,
        vaultName: '',
        saveMethod: 'uri',
        restBaseUrl: DEFAULT_SETTINGS.restBaseUrl,
        restApiKey: '',
        defaultFolder: DEFAULT_SETTINGS.defaultFolder,
      };
      return { ...prev, vaultProfiles: [...prev.vaultProfiles, np], activeProfileId: id };
    });
  }

  function removeProfile(id: string) {
    setS((prev) => {
      if (prev.vaultProfiles.length <= 1) return prev;
      const remaining = prev.vaultProfiles.filter((p) => p.id !== id);
      return {
        ...prev,
        vaultProfiles: remaining,
        activeProfileId: prev.activeProfileId === id ? remaining[0].id : prev.activeProfileId,
      };
    });
  }

  async function testProfile(p: VaultProfile) {
    setTestId(p.id);
    setTestingId(p.id);
    setTestMsg('');
    const r = await testRest({ baseUrl: p.restBaseUrl, apiKey: p.restApiKey });
    setTestMsg(r.msg);
    setTestingId('');
  }

  function toggleField(key: FieldKey) {
    setS((prev) => ({
      ...prev,
      frontmatterFields: {
        ...prev.frontmatterFields,
        [key]: !prev.frontmatterFields[key],
      },
    }));
  }

  // 自定义字段增删改
  function setCustomField(i: number, patch: Partial<{ key: string; value: string }>) {
    setS((prev) => {
      const next = [...prev.customFields];
      next[i] = { ...next[i], ...patch };
      return { ...prev, customFields: next };
    });
  }
  function addCustomField() {
    setS((prev) => ({ ...prev, customFields: [...prev.customFields, { key: '', value: '' }] }));
  }
  function removeCustomField(i: number) {
    setS((prev) => ({ ...prev, customFields: prev.customFields.filter((_, j) => j !== i) }));
  }

  async function handleSave() {
    await saveSettings(s);
    setSavedMsg(T.settingsSaved);
    setTimeout(() => setSavedMsg(''), 1800);
  }

  return (
    <div className="zc-opt">
      <header className="zc-opt-head">
        <img className="zc-opt-logo" src="/logo.png" alt="" />
        <h1>{T.settingsTitle}</h1>
      </header>

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsTheme}</div>
        <div className="zc-radios">
          {([
            ['auto', T.themeAuto],
            ['light', T.themeLight],
            ['dark', T.themeDark],
          ] as const).map(([val, label]) => (
            <label className="zc-check" key={val}>
              <input
                type="radio"
                name="theme"
                checked={s.theme === val}
                onChange={() => update('theme', val)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupArchive}</div>
        <p className="zc-hint">{T.settingsArchiveFolderMoved}</p>

        <label className="zc-check">
          <input
            type="checkbox"
            checked={s.folderPerClip}
            onChange={(e) => update('folderPerClip', e.target.checked)}
          />
          {T.settingsFolderPerClip}
        </label>
        {s.folderPerClip ? (
          <>
            <label className="zc-l">{T.settingsFolderTpl}</label>
            <input
              className="zc-i"
              value={s.folderNameTemplate}
              onChange={(e) => update('folderNameTemplate', e.target.value)}
            />
            <p className="zc-hint">{T.settingsFolderTplHint}</p>
          </>
        ) : (
          <>
            <label className="zc-l">{T.settingsAttachFolder}</label>
            <input
              className="zc-i"
              value={s.attachmentsFolder}
              onChange={(e) => update('attachmentsFolder', e.target.value)}
            />
            <p className="zc-hint">{T.settingsAttachFolderHint}</p>
          </>
        )}

        <label className="zc-l zc-mt">{T.settingsFilename}</label>
        <input
          className="zc-i"
          value={s.filenameTemplate}
          onChange={(e) => update('filenameTemplate', e.target.value)}
        />
        <p className="zc-hint">{T.settingsFilenameHint}</p>
      </div>

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsAutoTags}</div>
        <div className="zc-two-cols">
          <div>
            <label className="zc-l">{T.settingsUnreadTag}</label>
            <input
              className="zc-i"
              value={s.unreadTag}
              onChange={(e) => update('unreadTag', e.target.value)}
            />
          </div>
          <div>
            <label className="zc-l">{T.settingsLearnedTag}</label>
            <input
              className="zc-i"
              value={s.learnedTag}
              onChange={(e) => update('learnedTag', e.target.value)}
            />
          </div>
        </div>
        <p className="zc-hint">{T.settingsReadingTagHint}</p>
      </div>

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupProps}</div>
        <label className="zc-check">
          <input
            type="checkbox"
            checked={s.includeFrontmatter}
            onChange={(e) => update('includeFrontmatter', e.target.checked)}
          />
          {T.settingsFrontmatter}
        </label>
        {s.includeFrontmatter && (
          <>
            <div className="zc-fields">
              {/* tags 字段已交给下游 Agent 处理，clipper 不再写入，故不在此提供开关 */}
              {(Object.keys(s.frontmatterFields) as FieldKey[])
                .filter((key) => key !== 'tags')
                .map((key) => (
                <label className="zc-check" key={key}>
                  <input
                    type="checkbox"
                    checked={s.frontmatterFields[key]}
                    onChange={() => toggleField(key)}
                  />
                  {T.fieldNames[key]}
                </label>
              ))}
            </div>

            <label className="zc-l zc-mt">{T.settingsCustomFields}</label>
            {s.customFields.map((cf, i) => (
              <div className="zc-cf-row" key={i}>
                <input
                  className="zc-i zc-cf-key"
                  placeholder={T.cfKey}
                  value={cf.key}
                  onChange={(e) => setCustomField(i, { key: e.target.value })}
                />
                <input
                  className="zc-i zc-cf-val"
                  placeholder={T.cfValue}
                  value={cf.value}
                  onChange={(e) => setCustomField(i, { value: e.target.value })}
                />
                <button
                  className="zc-cf-del"
                  title="删除"
                  onClick={() => removeCustomField(i)}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="zc-cf-add" onClick={addCustomField}>
              {T.cfAdd}
            </button>
            <p className="zc-hint">{T.settingsCustomFieldsHint}</p>
          </>
        )}
      </div>

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupVaults}</div>
        <p className="zc-hint">{T.settingsVaultsHint}</p>
        {s.vaultProfiles.map((p) => {
          const pRest = p.saveMethod === 'rest';
          const active = p.id === s.activeProfileId;
          return (
            <div className={'zc-vault-card' + (active ? ' on' : '')} key={p.id}>
              <div className="zc-vault-head">
                <input
                  className="zc-i zc-vault-name"
                  value={p.vaultName}
                  placeholder={T.profileVaultPlaceholder}
                  onChange={(e) => updateProfile(p.id, { vaultName: e.target.value })}
                />
                <button
                  className={'zc-btn zc-btn-ghost zc-profile-active-btn' + (active ? ' on' : '')}
                  onClick={() => setActiveProfile(p.id)}
                >
                  {active ? T.profileActive : T.profileSetActive}
                </button>
                <button
                  className="zc-cf-del"
                  title="删除"
                  disabled={s.vaultProfiles.length <= 1}
                  onClick={() => removeProfile(p.id)}
                >
                  ✕
                </button>
              </div>
              <div className="zc-vault-methods">
                <label className="zc-check">
                  <input
                    type="radio"
                    name={'m-' + p.id}
                    checked={!pRest}
                    onChange={() => updateProfile(p.id, { saveMethod: 'uri' })}
                  />
                  {T.settingsMethodUri}
                </label>
                <label className="zc-check">
                  <input
                    type="radio"
                    name={'m-' + p.id}
                    checked={pRest}
                    onChange={() => updateProfile(p.id, { saveMethod: 'rest' })}
                  />
                  {T.settingsMethodRest}
                </label>
              </div>
              {pRest ? (
                <>
                  <label className="zc-l">{T.settingsRestUrl}</label>
                  <input
                    className="zc-i"
                    value={p.restBaseUrl}
                    onChange={(e) => updateProfile(p.id, { restBaseUrl: e.target.value })}
                  />
                  <label className="zc-l">{T.settingsRestKey}</label>
                  <input
                    className="zc-i"
                    type="password"
                    value={p.restApiKey}
                    onChange={(e) => updateProfile(p.id, { restApiKey: e.target.value })}
                  />
                  <div className="zc-actions">
                    <button
                      className="zc-btn zc-btn-ghost"
                      onClick={() => testProfile(p)}
                      disabled={testingId === p.id}
                    >
                      {testingId === p.id ? '…' : T.settingsRestTest}
                    </button>
                    {testId === p.id && testMsg && <span className="zc-ok">{testMsg}</span>}
                  </div>
                  <p className="zc-hint">{T.settingsRestKeyHint}</p>
                </>
              ) : (
                <p className="zc-hint">{T.settingsMethodUriHint}</p>
              )}
              <label className="zc-l zc-mt">{T.settingsFolder}</label>
              <input
                className="zc-i"
                value={p.defaultFolder}
                placeholder="如 剪藏/"
                onChange={(e) => updateProfile(p.id, { defaultFolder: e.target.value })}
              />
              <p className="zc-hint">{T.settingsFolderHint}</p>
            </div>
          );
        })}
        <button className="zc-cf-add" onClick={addProfile}>
          {T.profileAdd}
        </button>
        <p className="zc-hint">{T.settingsVaultNameHint}</p>
      </div>

      <div className="zc-sticky-save">
        <button className="zc-btn" onClick={handleSave}>
          {T.settingsSave}
        </button>
        {savedMsg && <span className="zc-ok">{savedMsg}</span>}
      </div>
    </div>
  );
}
