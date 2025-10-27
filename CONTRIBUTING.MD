# Contributing to Aluvia Playwright

Thank you for your interest in contributing!

## Development Process

### Pull Requests
- Fork the [repository](https://github.com/xtrella/aluvia-playwright).
- Create a new branch for your feature or fix.
- Open a pull request (PR) against the `main` branch.
- Ensure your PR describes the change clearly and references any related issues.

### Development Setup
1. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/aluvia-playwright.git
   cd aluvia-playwright
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Run tests (if available):
   ```bash
   npm test
   ```

### Code Style
- Use TypeScript and follow the style in [`src/index.ts`](src/index.ts).
- Prefer descriptive variable and function names.
- Keep functions small and focused.
- Use consistent indentation (2 spaces).
- Run `npm run build` before submitting.

### Commit Messages

We follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools

Examples:

- `feat(proxy): add sticky session support`
- `fix(auth): handle invalid token errors`
- `docs(readme): update installation instructions`

## Bug Reports

**Great Bug Reports** tend to have:
- A clear title and description.
- Steps to reproduce the issue.
- Expected vs. actual behavior.
- Environment details (Node.js version, OS, etc.).
- Relevant logs or error messages.

Please submit bugs via [GitHub Issues](https://github.com/xtrella/aluvia-playwright/issues).

## Feature Requests

- Describe the problem your feature solves.
- Suggest a solution or API change.
- Include example usage if possible.
- Open a [GitHub Issue](https://github.com/xtrella/aluvia-playwright/issues) for discussion.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## Questions?

Don't hesitate to reach out:

- 💬 Discord: [Join our community](https://discord.gg/aluvia)
- 📧 Email: support@aluvia.io
- 🐛 Issues: [GitHub Issues](https://github.com/xtrella/aluvia-playwright/issues)