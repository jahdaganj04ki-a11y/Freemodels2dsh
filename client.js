/**
 * freemodels2dsh client entry.
 *
 * Registers one settings tab ("Free Models"). The tab lists every curated
 * free-tier provider; clicking a provider opens its account settings modal,
 * where accounts are added/removed/enabled/disabled, the switching policy is
 * chosen (manual, on-error/quota, round robin), keys can be tested, and the
 * free-model list can be refreshed live.
 *
 * Plain ES module loaded through window.__ModuleLoader__; React is reached via
 * the host module baseline, so no build step is required.
 */
window.__ModuleLoader__.load({
  id: 'freemodels2dsh',
  factory: require => {
    const React = require('react')
    const {
      Modal, Button, Switch, SegmentedControl, Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const NS = 'settings.freemodels2dsh'
    const zh = {
      title: '免费模型',
      description: '集中管理各厂商免费套餐的云端模型，支持多账号与自动切换（不含任何本地模型）。',
      accounts: '账号',
      noAccounts: '尚未添加账号',
      enabled: '已启用',
      disabled: '已停用',
      mode: '账号切换方式',
      modeManual: '手动切换',
      modeOnError: '出错/额度耗尽时',
      modeRoundRobin: '轮流使用',
      modeManualHint: '仅使用当前选中的账号，点击账号行的单选按钮手动切换。',
      modeOnErrorHint: '优先使用当前账号；遇到密钥失效、额度耗尽、限流或服务器错误时自动切换到下一个可用账号。',
      modeRoundRobinHint: '每次新请求自动轮换到下一个可用账号；出错时同样自动跳过故障账号。',
      addAccount: '添加账号',
      label: '账号名称（可选）',
      labelPlaceholder: '例如：主账号',
      apiKey: 'API Key',
      apiKeyPlaceholder: '粘贴该服务商的 API Key',
      accountId: 'Cloudflare Account ID',
      accountIdPlaceholder: '32 位十六进制 Account ID',
      add: '添加',
      remove: '移除',
      confirmRemove: '确认移除？再次点击以确认。',
      enable: '启用',
      makeActive: '设为当前账号',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接成功',
      models: '免费模型',
      visionBadge: '视觉',
      reasoningBadge: '推理',
      refreshAll: '更新所有免费模型列表',
      refreshingAll: '更新中…',
      refreshAllDone: '已更新 {count} 个服务商的免费模型列表。',
      refreshAllPartial: '已更新 {updated} 个服务商，{failed} 个失败。',
      refreshAllNone: '还没有可刷新的服务商，请先添加账号。',
      keylessHint: '该服务商支持匿名免费访问，API Key 可留空（按 IP 限流）。',
      anonymous: '匿名',
      builtInModels: '内置清单',
      refreshedModels: '已从服务商刷新',
      fetchModels: '获取可用模型',
      fetchingModels: '获取中…',
      resetModels: '恢复内置清单',
      signup: '注册/获取 Key',
      docs: '费率说明',
      freeNote: '免费说明',
      close: '关闭',
      loading: '正在加载配置…',
      loadFailed: '配置加载失败，请重试。',
      retry: '重试',
      statusOk: '正常',
      statusCooling: '冷却中',
      statusError: '最近报错',
      noEnabledAccount: '请先添加并启用至少一个账号，模型才会出现在模型选择器中。',
      providerHint: '只有免费套餐或免费额度内可用的模型才会列出；需要付费方式的服务商和模型不会出现。',
      errorConflict: '配置已在其他窗口更改，正在重新加载。',
      errorBadKey: 'API Key 无效（需 8–4096 个字符，且不能含空格）。',
      errorBadAccountId: '请填写 32 位 Cloudflare Account ID。',
      errorNoAccount: '该服务商还没有可用账号。',
      errorNoModels: '该账号没有返回任何免费模型。',
      errorUnknown: '操作失败，请稍后重试。',
    }
    const en = {
      title: 'Free Models',
      description: 'Manage free-tier cloud models from every supported provider with multiple accounts and automatic rotation. No local models.',
      accounts: 'Accounts',
      noAccounts: 'No account yet',
      enabled: 'Enabled',
      disabled: 'Disabled',
      mode: 'Account switching',
      modeManual: 'Manual',
      modeOnError: 'On error / quota',
      modeRoundRobin: 'Round robin',
      modeManualHint: 'Only the selected account is used. Switch manually by clicking the radio button on an account row.',
      modeOnErrorHint: 'Starts with the active account and automatically moves to the next usable account on invalid key, exhausted quota, rate limiting, or server errors.',
      modeRoundRobinHint: 'Each new request rotates to the next usable account; failed accounts are skipped automatically.',
      addAccount: 'Add account',
      label: 'Account label (optional)',
      labelPlaceholder: 'e.g. primary account',
      apiKey: 'API key',
      apiKeyPlaceholder: 'Paste the provider API key',
      accountId: 'Cloudflare account ID',
      accountIdPlaceholder: '32-character hexadecimal account ID',
      add: 'Add',
      remove: 'Remove',
      confirmRemove: 'Remove this account? Click again to confirm.',
      enable: 'Enabled',
      makeActive: 'Make active',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK',
      models: 'Free models',
      visionBadge: 'vision',
      reasoningBadge: 'reasoning',
      refreshAll: 'Update all free model lists',
      refreshingAll: 'Updating…',
      refreshAllDone: 'Updated the free model lists of {count} provider(s).',
      refreshAllPartial: 'Updated {updated} provider(s); {failed} failed.',
      refreshAllNone: 'No provider can be refreshed yet — add an account first.',
      keylessHint: 'This provider allows anonymous free access; the API key is optional (rate limit applies per IP).',
      anonymous: 'anonymous',
      builtInModels: 'built-in list',
      refreshedModels: 'refreshed from provider',
      fetchModels: 'Fetch available models',
      fetchingModels: 'Fetching…',
      resetModels: 'Reset to built-in list',
      signup: 'Get API key',
      docs: 'Limits & docs',
      freeNote: 'Free-tier note',
      close: 'Close',
      loading: 'Loading settings…',
      loadFailed: 'Could not load the settings. Try again.',
      retry: 'Retry',
      statusOk: 'healthy',
      statusCooling: 'cooling down',
      statusError: 'last error',
      noEnabledAccount: 'Add and enable at least one account so its free models appear in the model picker.',
      providerHint: 'Only models available on a free tier or free allotment are listed. Providers and models requiring a payment method never appear.',
      errorConflict: 'The settings changed in another window. Reloading…',
      errorBadKey: 'Invalid API key (8–4096 characters, no whitespace).',
      errorBadAccountId: 'Enter the 32-character Cloudflare account ID.',
      errorNoAccount: 'This provider has no usable account yet.',
      errorNoModels: 'The account returned no free models.',
      errorUnknown: 'The operation failed. Try again later.',
    }

    const css = `
.fm2d-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;transition:border-color .16s,background .16s}
.fm2d-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.fm2d-head{padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.fm2d-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.fm2d-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.fm2d-list{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px;display:flex;flex-direction:column;gap:6px}
.fm2d-row{appearance:none;display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:transparent;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px;color:inherit;font:inherit;cursor:pointer}
.fm2d-row:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.fm2d-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fm2d-row-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm2d-row-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.fm2d-row-tags{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.fm2d-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0;padding:0 16px 14px}
.fm2d-modal-body{display:flex;flex-direction:column;gap:16px;min-width:min(560px,80vw)}
.fm2d-section{display:flex;flex-direction:column;gap:8px}
.fm2d-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.fm2d-section-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}
.fm2d-accounts{display:flex;flex-direction:column;gap:8px}
.fm2d-account{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-3)}
.fm2d-account.fm2d-off{opacity:.65}
.fm2d-account-top{display:flex;align-items:center;gap:10px;min-width:0}
.fm2d-radio{appearance:none;margin:0;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l4);flex:none;cursor:pointer;position:relative}
.fm2d-radio:checked{border-color:var(--dsw-alias-brand-primary)}
.fm2d-radio:checked::after{content:'';position:absolute;inset:3px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.fm2d-radio:disabled{cursor:default;opacity:.5}
.fm2d-account-name{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm2d-account-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fm2d-account-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.fm2d-form{display:flex;flex-direction:column;gap:8px;border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:12px}
.fm2d-field{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.fm2d-field input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400}
.fm2d-field input::placeholder{color:var(--dsw-alias-label-tertiary)}
.fm2d-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fm2d-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);margin:0}
.fm2d-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin:0}
.fm2d-model-list{margin:0;padding:0;max-height:160px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px}
.fm2d-model-list li{list-style:none;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.fm2d-model-list li:last-child{border-bottom:0}
.fm2d-model-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.fm2d-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm2d-model-tags{display:flex;gap:4px;flex-shrink:0}
.fm2d-links{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}
.fm2d-links a{color:var(--dsw-alias-brand-primary)}
.fm2d-card :focus-visible,.fm2d-modal-body :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.fm2d-card,.fm2d-row{transition:none}}
`

    const ERROR_KEYS = {
      CONFLICT: 'errorConflict',
      BAD_KEY: 'errorBadKey',
      BAD_ACCOUNT_ID: 'errorBadAccountId',
      NO_ACCOUNT: 'errorNoAccount',
      NO_MODELS: 'errorNoModels',
    }
    function errorKey(code) {
      return ERROR_KEYS[code] ?? 'errorUnknown'
    }

    function StatusTag({ status, t }) {
      if (!status) return null
      if (status.cooling) return h(Tag, { tone: 'warning' }, `${t('statusCooling')} · ${Math.ceil((status.cooldownRemainingMs ?? 0) / 1000)}s`)
      if (status.state === 'error') return h(Tag, { tone: 'danger' }, t('statusError'))
      return h(Tag, { tone: 'success' }, t('statusOk'))
    }

    function ProviderModal({ catalogProvider, providerState, revision, busy, error, notice, onClose, onAction, t }) {
      const [form, setForm] = React.useState({ label: '', apiKey: '', accountId: '' })
      const [confirmId, setConfirmId] = React.useState(null)
      const [testId, setTestId] = React.useState(null)
      const accounts = providerState?.accounts ?? []
      const mode = providerState?.switchMode ?? 'on-error'
      const models = providerState?.models
      const enabledCount = accounts.filter(account => account.enabled).length

      const set = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }))

      const add = async event => {
        event.preventDefault()
        setTestId(null)
        const result = await onAction('account-add', {
          revision,
          providerId: catalogProvider.id,
          label: form.label.trim(),
          apiKey: form.apiKey.trim(),
          ...(catalogProvider.requiresAccountId ? { accountId: form.accountId.trim() } : {}),
        })
        // Keep the draft intact when validation failed so the key can be corrected.
        if (result) setForm({ label: '', apiKey: '', accountId: '' })
      }

      return h(Modal, {
        open: true,
        onClose,
        title: catalogProvider.name,
        closeLabel: t('close'),
        description: t('providerHint'),
        footer: h(Button, { variant: 'primary', onClick: onClose }, t('close')),
      },
      h('div', { className: 'fm2d-modal-body' },
        h('div', { className: 'fm2d-links' },
          h('a', { href: catalogProvider.signupUrl, target: '_blank', rel: 'noreferrer' }, t('signup')),
          h('a', { href: catalogProvider.docsUrl, target: '_blank', rel: 'noreferrer' }, t('docs'))),
        catalogProvider.freeNote && h('p', { className: 'fm2d-section-hint' },
          `${t('freeNote')}: ${catalogProvider.freeNote}`),
        h('section', { className: 'fm2d-section' },
          h('p', { className: 'fm2d-section-title' }, t('mode')),
          h(SegmentedControl, {
            id: `fm2d-mode-${catalogProvider.id}`,
            label: t('mode'),
            disabled: busy,
            value: mode,
            options: [
              { value: 'manual', label: t('modeManual') },
              { value: 'on-error', label: t('modeOnError') },
              { value: 'round-robin', label: t('modeRoundRobin') },
            ],
            onChange: value => onAction('switch-mode', { revision, providerId: catalogProvider.id, mode: value }),
          }),
          h('p', { className: 'fm2d-section-hint' },
            mode === 'manual' ? t('modeManualHint') : mode === 'round-robin' ? t('modeRoundRobinHint') : t('modeOnErrorHint'))),
        h('section', { className: 'fm2d-section' },
          h('p', { className: 'fm2d-section-title' }, `${t('accounts')} (${enabledCount}/${accounts.length})`),
          accounts.length === 0 && h('p', { className: 'fm2d-section-hint' }, t('noAccounts')),
          h('div', { className: 'fm2d-accounts' }, accounts.map(account =>
            h('div', { key: account.id, className: `fm2d-account${account.enabled ? '' : ' fm2d-off'}` },
              h('div', { className: 'fm2d-account-top' },
                h('input', {
                  type: 'radio',
                  className: 'fm2d-radio',
                  name: `fm2d-active-${catalogProvider.id}`,
                  'aria-label': t('makeActive'),
                  title: mode === 'manual' ? t('makeActive') : t('modeManual'),
                  checked: providerState.manualAccountId === account.id,
                  disabled: busy || !account.enabled || mode !== 'manual',
                  onChange: () => onAction('account-select', { revision, providerId: catalogProvider.id, accountId: account.id }),
                }),
                h('span', { className: 'fm2d-account-name' }, account.label),
                h(StatusTag, { status: account.status, t }),
                h(Switch, {
                  checked: account.enabled,
                  disabled: busy,
                  label: t('enable'),
                  onChange: enabled => onAction('account-toggle', { revision, providerId: catalogProvider.id, accountId: account.id, enabled }),
                })),
              h('div', { className: 'fm2d-account-meta' },
                account.keyHint
                  ? h('span', null, account.keyHint)
                  : (catalogProvider.keyless ? h(Tag, { tone: 'neutral' }, t('anonymous')) : h('span', null, '—')),
                account.accountId ? h('span', null, account.accountId.slice(0, 8) + '…') : null,
                account.enabled ? h('span', null, t('enabled')) : h('span', null, t('disabled'))),
              h('div', { className: 'fm2d-account-actions' },
                h(Button, {
                  size: 'sm', variant: 'outline', disabled: busy || testId === account.id,
                  onClick: async () => {
                    setTestId(account.id)
                    try {
                      await onAction('account-test', { providerId: catalogProvider.id, accountId: account.id })
                    } finally {
                      setTestId(null)
                    }
                  },
                }, testId === account.id ? t('testing') : t('test')),
                h(Button, {
                  size: 'sm', variant: 'ghost', disabled: busy,
                  onClick: () => {
                    if (confirmId === account.id) {
                      setConfirmId(null)
                      onAction('account-remove', { revision, providerId: catalogProvider.id, accountId: account.id })
                    } else setConfirmId(account.id)
                  },
                }, confirmId === account.id ? t('confirmRemove') : t('remove')))))),
          h('form', { className: 'fm2d-form', onSubmit: add },
            h('label', { className: 'fm2d-field' }, t('label'),
              h('input', { value: form.label, onChange: set('label'), placeholder: t('labelPlaceholder'), maxLength: 80, autoComplete: 'off' })),
            h('label', { className: 'fm2d-field' }, t('apiKey'),
              h('input', {
                type: 'password', value: form.apiKey, onChange: set('apiKey'),
                placeholder: t('apiKeyPlaceholder'), autoComplete: 'off', spellCheck: false,
                'data-modal-autofocus': '',
              })),
            catalogProvider.keyless && h('p', { className: 'fm2d-section-hint' }, t('keylessHint')),
            catalogProvider.requiresAccountId && h('label', { className: 'fm2d-field' }, t('accountId'),
              h('input', { value: form.accountId, onChange: set('accountId'), placeholder: t('accountIdPlaceholder'), autoComplete: 'off', spellCheck: false, maxLength: 32 })),
            h('div', { className: 'fm2d-actions' },
              h(Button, {
                type: 'submit',
                variant: 'primary',
                disabled: busy || (!catalogProvider.keyless && form.apiKey.trim().length === 0),
              }, t('add'))))),
        h('section', { className: 'fm2d-section' },
          h('p', { className: 'fm2d-section-title' }, t('models')),
          h('div', { className: 'fm2d-actions' },
            h(Button, {
              size: 'sm', variant: 'outline', disabled: busy || enabledCount === 0,
              onClick: () => onAction('models-refresh', { revision, providerId: catalogProvider.id }),
            }, busy ? t('fetchingModels') : t('fetchModels')),
            models && h(Button, {
              size: 'sm', variant: 'ghost', disabled: busy,
              onClick: () => onAction('models-reset', { revision, providerId: catalogProvider.id }),
            }, t('resetModels')),
            h(Tag, { tone: models ? 'info' : 'neutral' }, models ? t('refreshedModels') : t('builtInModels'))),
          h('ul', { className: 'fm2d-model-list' },
            (models ?? catalogProvider.defaultModels ?? []).map(model =>
              h('li', { key: model.id, className: 'fm2d-model-row' },
                h('span', { className: 'fm2d-model-name' }, `${model.name ?? model.id} — ${model.id}`),
                h('span', { className: 'fm2d-model-tags' },
                  model.vision && h(Tag, { tone: 'info' }, t('visionBadge')),
                  model.reasoning && h(Tag, { tone: 'neutral' }, t('reasoningBadge'))))))),
        enabledCount === 0 && h('p', { className: 'fm2d-section-hint' }, t('noEnabledAccount')),
        error && h('p', { className: 'fm2d-error', role: 'alert' }, t(errorKey(error.code))),
        notice && h('p', { className: 'fm2d-ok', role: 'status' }, notice)
      ))
    }

    function FreeModelsCard({ callApi, t }) {
      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadFailed, setLoadFailed] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const lifetime = React.useRef(null)

      const load = React.useCallback(async signal => {
        setLoading(true)
        setLoadFailed(false)
        try {
          setState(await callApi('state', null, { method: 'GET', signal }))
        } catch (caught) {
          if (!signal?.aborted) setLoadFailed(true)
        } finally {
          if (!signal?.aborted) setLoading(false)
        }
      }, [callApi])

      React.useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        void load(controller.signal)
        return () => controller.abort()
      }, [load])

      const onAction = React.useCallback(async (endpoint, payload) => {
        if (busy) return null
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const next = await callApi(endpoint, payload, { signal: lifetime.current?.signal })
          setState(next)
          if (endpoint === 'account-test') setNotice(t('testOk'))
          return next
        } catch (caught) {
          if (caught?.code === 'CONFLICT') {
            setError({ code: 'CONFLICT' })
            void load(lifetime.current?.signal)
          } else {
            setError(caught?.code ? caught : { code: 'UNKNOWN' })
          }
          return null
        } finally {
          setBusy(false)
        }
      }, [busy, callApi, load, t])

      const catalog = state?.catalog ?? []
      const openProvider = catalog.find(item => item.id === openId)
      const openState = openId ? state?.providers?.[openId] : undefined

      const refreshAll = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const next = await callApi('models-refresh-all', {
            revision: state?.revision ?? 0,
          }, { signal: lifetime.current?.signal })
          setState(next)
          const updated = next.refresh?.updated?.length ?? 0
          const failed = next.refresh?.failed?.length ?? 0
          if (updated === 0) setNotice(t('refreshAllNone'))
          else if (failed > 0) {
            setNotice(t('refreshAllPartial').replace('{updated}', updated).replace('{failed}', failed))
          } else {
            setNotice(t('refreshAllDone').replace('{count}', updated))
          }
        } catch (caught) {
          if (caught?.code === 'CONFLICT') {
            setError({ code: 'CONFLICT' })
            void load(lifetime.current?.signal)
          } else {
            setError(caught?.code ? caught : { code: 'UNKNOWN' })
          }
        } finally {
          setBusy(false)
        }
      }, [busy, callApi, load, state, t])

      return h('section', { className: 'fm2d-card', 'data-testid': 'freemodels2dsh-card' },
        h('div', { className: 'fm2d-head' },
          h('span', { className: 'fm2d-title' }, t('title')),
          h('p', { className: 'fm2d-desc' }, t('description')),
          h('div', { className: 'fm2d-actions' },
            h(Button, {
              size: 'sm', variant: 'outline', disabled: busy || loading, onClick: refreshAll,
            }, busy ? t('refreshingAll') : t('refreshAll')))),
        loading
          ? h('p', { className: 'fm2d-hint' }, t('loading'))
          : h('div', { className: 'fm2d-list' },
              loadFailed
                ? h('div', { className: 'fm2d-actions', style: { padding: '4px 0' } },
                    h('p', { className: 'fm2d-error', role: 'alert' }, t('loadFailed')),
                    h(Button, { size: 'sm', variant: 'outline', onClick: () => load(lifetime.current?.signal) }, t('retry')))
                : catalog.map(catalogProvider => {
                    const providerState = state?.providers?.[catalogProvider.id]
                    const accounts = providerState?.accounts ?? []
                    const enabled = accounts.filter(account => account.enabled).length
                    const hasError = accounts.some(account => account.status?.state === 'error' || account.status?.cooling)
                    return h('button', {
                      key: catalogProvider.id,
                      type: 'button',
                      className: 'fm2d-row',
                      'aria-haspopup': 'dialog',
                      onClick: () => { setError(null); setNotice(null); setOpenId(catalogProvider.id) },
                    },
                      h('span', { className: 'fm2d-row-main' },
                        h('span', { className: 'fm2d-row-name' }, catalogProvider.name),
                        h('span', { className: 'fm2d-row-meta' },
                          `${t('accounts')}: ${accounts.length === 0 ? t('noAccounts') : `${enabled}/${accounts.length}`}`)),
                      h('span', { className: 'fm2d-row-tags' },
                        hasError ? h(Tag, { tone: 'warning' }, t('statusError'))
                          : enabled > 0 ? h(Tag, { tone: 'success' }, t('enabled'))
                            : h(Tag, { tone: 'neutral' }, t('noAccounts'))),
                      h('span', { 'aria-hidden': true }, '›'))
                  })),
        h('p', { className: 'fm2d-hint' }, t('providerHint')),
        openProvider && h(ProviderModal, {
          catalogProvider: openProvider,
          providerState: openState,
          revision: state?.revision ?? 0,
          busy,
          error,
          notice,
          t,
          onClose: () => setOpenId(null),
          onAction,
        }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const callApi = async (endpoint, payload, options = {}) => {
          const isGet = options.method === 'GET'
          const response = await fetch(`/api/freemodels2dsh.${endpoint}`, {
            method: isGet ? 'GET' : 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: options.signal,
            ...(isGet ? {} : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload ?? {}),
            }),
          })
          const text = await response.text()
          let data = {}
          try {
            data = text ? JSON.parse(text) : {}
          } catch {
            throw { code: 'UNAVAILABLE' }
          }
          if (!response.ok) throw data.code ? data : { code: 'UNAVAILABLE' }
          return data
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'freemodels2dsh locale')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'freemodels2dsh'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'freemodels2dsh styles')

        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'freemodels2dsh',
          order: -90,
          locale: NS,
          label: () => t('title'),
          inject: () => ({ callApi }),
        }, FreeModelsCard))
      },
    }
  },
})
