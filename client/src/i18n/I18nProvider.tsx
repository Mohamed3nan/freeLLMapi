import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'

import en from './locales/en.json'

export const SUPPORTED_LOCALES = ['en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

type Dictionary = Record<string, unknown>

const dictionaries: Record<Locale, Dictionary> = {
  en: en as Dictionary,
}

function lookup(dict: Dictionary, key: string): unknown {
  const segments = key.split('.')
  let cur: unknown = dict
  for (const seg of segments) {
    if (cur && typeof cur === 'object' && seg in (cur as Dictionary)) {
      cur = (cur as Dictionary)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name]
    return v === undefined || v === null ? `{${name}}` : String(v)
  })
}

interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  toggleLocale: () => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export interface I18nProviderProps {
  children: ReactNode
  initialLocale?: Locale
}

export function I18nProvider({ children }: I18nProviderProps) {
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('freellmapi.locale', DEFAULT_LOCALE)
    document.documentElement.lang = DEFAULT_LOCALE
  }, [])

  const setLocale = useCallback(() => {}, [])
  const toggleLocale = useCallback(() => {}, [])

  const value = useMemo<I18nContextValue>(() => {
    const dict = dictionaries[DEFAULT_LOCALE]
    return {
      locale: DEFAULT_LOCALE,
      setLocale,
      toggleLocale,
      t: (key, vars) => {
        const raw = lookup(dict, key)
        if (typeof raw === 'string') return interpolate(raw, vars)
        return key
      },
    }
  }, [setLocale, toggleLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      toggleLocale: () => {},
      t: (key) => key,
    }
  }
  return ctx
}
