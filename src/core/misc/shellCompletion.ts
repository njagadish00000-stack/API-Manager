/** Shell completion script for the api-manager CLI (§63). */
export const SHELL_COMPLETION_BASH = `# api-manager bash completion
_api_manager_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="send run test flow monitor validate docs mock import export completion version help serve"
  case "\${COMP_CWORD}" in
    1)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=( $(compgen -W "--help --workspace --environment --timeout --proxy --cert --verbose --quiet --json --junit --html --iterations --delay --data --var --output --format --port --insecure" -- "\${cur}") )
      ;;
  esac
  return 0
}
complete -F _api_manager_completions api-manager
`;

export const SHELL_COMPLETION_ZSH = `#compdef api-manager
_api-manager() {
  local -a commands
  commands=(
    'send:Send a single request'
    'run:Run a collection or folder'
    'test:Run tests for a collection'
    'flow:Run a flow'
    'monitor:Run a monitor once'
    'validate:Validate a specification'
    'docs:Generate documentation'
    'mock:Start a mock server'
    'import:Import a file'
    'export:Export a collection'
    'completion:Print shell completion script'
    'serve:Start the local hub server'
  )
  _arguments \\
    '1: :->command' \\
    '*: :->args'
  case $state in
    command) _describe 'command' commands ;;
    args) _arguments '--workspace[Workspace id]' '--environment[Environment id]' \\
      '--timeout[Timeout ms]' '--proxy[Proxy URL]' '--json[JSON output]' \\
      '--junit[JUnit output file]' '--iterations[Iterations]' '*:file:_files' ;;
  esac
}
_api-manager
`;
