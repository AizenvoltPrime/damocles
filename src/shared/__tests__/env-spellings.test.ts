import { describe, expect, it } from 'vitest';
import { envSpellings, withEnvOverrides } from '../env-spellings';

describe('environment variable spellings', () => {
  it('finds every case of a name on Windows and only the exact name elsewhere', () => {
    const env = { GIT_CONFIG_PARAMETERS: 'a', Git_Config_Parameters: 'b', PATH: 'p' };
    expect(envSpellings(env, 'git_config_parameters', 'win32')).toEqual(['GIT_CONFIG_PARAMETERS', 'Git_Config_Parameters']);
    expect(envSpellings(env, 'GIT_CONFIG_PARAMETERS', 'linux')).toEqual(['GIT_CONFIG_PARAMETERS']);
    expect(envSpellings(env, 'git_config_parameters', 'linux')).toEqual([]);
  });

  it('sets an override in place of every other spelling on Windows, and beside them elsewhere', () => {
    const base = { Git_Config_Parameters: 'inherited', Path: 'p' };
    expect(withEnvOverrides(base, { GIT_CONFIG_PARAMETERS: 'takeover' }, 'win32')).toEqual({ Path: 'p', GIT_CONFIG_PARAMETERS: 'takeover' });
    expect(withEnvOverrides(base, { GIT_CONFIG_PARAMETERS: 'takeover' }, 'linux')).toEqual({ ...base, GIT_CONFIG_PARAMETERS: 'takeover' });
    expect(base).toEqual({ Git_Config_Parameters: 'inherited', Path: 'p' });
  });
});
