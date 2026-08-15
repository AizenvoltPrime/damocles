# Quality Standards

## Core Principles

Always prioritize:

- **Simplicity**: Choose the most straightforward solution
- **Efficiency**: Optimize for performance and maintainability
- **Best Practices**: Follow established patterns for this codebase
- **Honesty**: Acknowledge limitations and suggest alternatives when needed
- **Accuracy**: Never provide false information or hallucinate details

## Code Quality Standards

**NEVER implement fallback business logic, backwards compatibility, lazy solutions or bandaid fixes**

- Write robust, well-designed code from the start
- Avoid temporary fixes or "quick and dirty" solutions
- Never add fallback mechanisms that mask underlying issues
- Implement proper error handling instead of silent failures
- Address root causes rather than symptoms
- Maintain high code quality standards throughout development
- Always write self-documenting code with clear naming and structure
- Use concise documentation comments for methods, classes, and properties to describe their purpose

## Implementation Guidelines

- **Root Cause Analysis**: When fixing bugs, investigate and address the underlying cause, not just the symptom
- **Design First**: Plan the solution architecture before writing code
- **Performance Awareness**: Consider performance implications from the start, not as an afterthought
- **Maintainability Focus**: Code should be easy to understand, modify, and extend by future developers

## Development Principles

When working with this codebase, prioritize these architectural patterns:

1. **Workflow-based Structure**: Organize code around business workflows rather than technical layers
2. **Vertical Sliced Architecture**: Group related functionality together across all layers
3. **Data-oriented Programming**: Separate data structures from functions that operate on them
4. **Locality of Behavior**: Keep related code physically close together
5. **Functional Approach**: Minimize OOP patterns in favor of functional programming where possible
6. **Tailwind**: Use Tailwind wherever you can instead of custom CSS
7. **shadcn-vue First**: Prefer shadcn-vue components from `src/webview/components/ui/` over raw HTML elements
