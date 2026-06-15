import { useEffect, useState } from 'react';
import { T } from '@/utils/strings';
import { loadSettings, saveSettings } from '@/utils/storage';
import { testRest } from '@/utils/rest';
import { DEFAULT_SETTINGS, Settings } from '@/utils/types';

type FieldKey = keyof Settings['frontmatterFields'];

export function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedMsg, setSavedMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadSettings().then(setS);
  }, []);

  // 应用主题到设置页本身（弹窗在 App.tsx 应用）
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
  }, [s.theme]);

  async function handleTest() {
    setTesting(true);
    setTestMsg('');
    const r = await testRest({ baseUrl: s.restBaseUrl, apiKey: s.restApiKey });
    setTestMsg(r.msg);
    setTesting(false);
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
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

  function setSiteTagRule(i: number, patch: Partial<{ domain: string; tag: string }>) {
    setS((prev) => {
      const next = [...prev.siteTagRules];
      next[i] = { ...next[i], ...patch };
      return { ...prev, siteTagRules: next };
    });
  }
  function addSiteTagRule() {
    setS((prev) => ({
      ...prev,
      siteTagRules: [...prev.siteTagRules, { domain: '', tag: '' }],
    }));
  }
  function removeSiteTagRule(i: number) {
    setS((prev) => ({
      ...prev,
      siteTagRules: prev.siteTagRules.filter((_, j) => j !== i),
    }));
  }

  async function handleSave() {
    await saveSettings(s);
    setSavedMsg(T.settingsSaved);
    setTimeout(() => setSavedMsg(''), 1800);
  }

  const isRest = s.saveMethod === 'rest';

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
        <div className="zc-group-title">{T.settingsSaveMethod}</div>
        <label className="zc-check">
          <input
            type="radio"
            name="method"
            checked={!isRest}
            onChange={() => update('saveMethod', 'uri')}
          />
          {T.settingsMethodUri}
        </label>
        <label className="zc-check">
          <input
            type="radio"
            name="method"
            checked={isRest}
            onChange={() => update('saveMethod', 'rest')}
          />
          {T.settingsMethodRest}
        </label>

        {isRest ? (
          <>
            <p className="zc-hint">{T.settingsRestGuide}</p>
            <label className="zc-l">{T.settingsRestUrl}</label>
            <input
              className="zc-i"
              value={s.restBaseUrl}
              onChange={(e) => update('restBaseUrl', e.target.value)}
            />
            <p className="zc-hint">{T.settingsRestUrlHint}</p>
            <label className="zc-l">{T.settingsRestKey}</label>
            <input
              className="zc-i"
              type="password"
              value={s.restApiKey}
              onChange={(e) => update('restApiKey', e.target.value)}
            />
            <p className="zc-hint">{T.settingsRestKeyHint}</p>
            <div className="zc-actions">
              <button className="zc-btn zc-btn-ghost" onClick={handleTest} disabled={testing}>
                {testing ? '…' : T.settingsRestTest}
              </button>
              {testMsg && <span className="zc-ok">{testMsg}</span>}
            </div>
          </>
        ) : (
          <>
            <label className="zc-l">{T.settingsVault}</label>
            <input
              className="zc-i"
              value={s.vaultName}
              placeholder="例如 我的笔记"
              onChange={(e) => update('vaultName', e.target.value)}
            />
            <p className="zc-hint">{T.settingsVaultHint}</p>
          </>
        )}
      </div>

      {isRest && (
        <div className="zc-group">
          <div className="zc-group-title">{T.settingsGroupImages}</div>
          <label className="zc-check">
            <input
              type="checkbox"
              checked={s.saveImagesLocal}
              onChange={(e) => update('saveImagesLocal', e.target.checked)}
            />
            {T.settingsSaveImages}
          </label>
          <p className="zc-hint">{T.settingsSaveImagesHint}</p>
          {/* 附件文件夹仅在「每篇独立文件夹」关闭时有用——开启时图片直接进该篇文件夹 */}
          {s.saveImagesLocal && !s.folderPerClip && (
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
          {s.saveImagesLocal && s.folderPerClip && (
            <p className="zc-hint">
              当前图片随每篇文章存进它的独立文件夹。想把<b>所有图片集中到一个文件夹</b>？到下方「归档与命名」取消勾选「每篇独立文件夹」，这里就会出现附件文件夹设置。
            </p>
          )}
        </div>
      )}

      <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupArchive}</div>
        <label className="zc-l">{T.settingsFolder}</label>
        <input
          className="zc-i"
          value={s.defaultFolder}
          onChange={(e) => update('defaultFolder', e.target.value)}
        />
        <p className="zc-hint">{T.settingsFolderHint}</p>

        <label className="zc-check zc-mt">
          <input
            type="checkbox"
            checked={s.folderPerClip}
            onChange={(e) => update('folderPerClip', e.target.checked)}
          />
          {T.settingsFolderPerClip}
        </label>
        {s.folderPerClip && (
          <>
            <label className="zc-l">{T.settingsFolderTpl}</label>
            <input
              className="zc-i"
              value={s.folderNameTemplate}
              onChange={(e) => update('folderNameTemplate', e.target.value)}
            />
            <p className="zc-hint">{T.settingsFolderTplHint}</p>
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
        <div className="zc-group-title">{T.settingsTagBlock}</div>
        <input
          className="zc-i"
          value={(s.tagBlocklist || []).join(', ')}
          onChange={(e) =>
            update(
              'tagBlocklist',
              e.target.value
                .split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean),
            )
          }
        />
        <p className="zc-hint">{T.settingsTagBlockHint}</p>
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

        <label className="zc-l zc-mt">{T.settingsSiteTags}</label>
        {s.siteTagRules.map((rule, i) => (
          <div className="zc-cf-row" key={i}>
            <input
              className="zc-i zc-site-domain"
              placeholder={T.siteDomain}
              value={rule.domain}
              onChange={(e) => setSiteTagRule(i, { domain: e.target.value })}
            />
            <input
              className="zc-i zc-site-tag"
              placeholder={T.siteTag}
              value={rule.tag}
              onChange={(e) => setSiteTagRule(i, { tag: e.target.value })}
            />
            <button className="zc-cf-del" title="删除" onClick={() => removeSiteTagRule(i)}>
              ✕
            </button>
          </div>
        ))}
        <button className="zc-cf-add" onClick={addSiteTagRule}>
          {T.addSiteRule}
        </button>
        <p className="zc-hint">{T.settingsSiteTagsHint}</p>
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
              {(Object.keys(s.frontmatterFields) as FieldKey[]).map((key) => (
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

      <div className="zc-sticky-save">
        <button className="zc-btn" onClick={handleSave}>
          {T.settingsSave}
        </button>
        {savedMsg && <span className="zc-ok">{savedMsg}</span>}
      </div>
    </div>
  );
}
