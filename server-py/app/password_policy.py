"""Politica de senha para contas LOCAIS (criacao e troca).

Vale so para senhas NOVAS (registro, criacao de usuario, reset por um
super_admin). O login continua aceitando qualquer senha ja existente, inclusive
as curtas criadas antes desta regra -- elas so precisam ser trocadas quando o
usuario/admin decidir. O teto de tamanho evita que alguem envie um corpo
gigante so para fazer o servidor gastar CPU/memoria no scrypt.
"""
from typing import Optional

PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 256


def password_problem(password, username: Optional[str] = None) -> Optional[str]:
    """Devolve a mensagem de erro (em ingles, como as demais da API) ou None se a
    senha e aceitavel."""
    if not isinstance(password, str) or not password:
        return '"password" is required'
    if len(password) < PASSWORD_MIN_LENGTH:
        return f'"password" must be at least {PASSWORD_MIN_LENGTH} characters'
    if len(password) > PASSWORD_MAX_LENGTH:
        return f'"password" must be at most {PASSWORD_MAX_LENGTH} characters'
    if username and password.strip().lower() == username.strip().lower():
        return '"password" must not be the same as the e-mail/username'
    return None
