"""
Fasáda pro zpětnou kompatibilitu: implementace je v balíčku `services.practice_tests`
(parsing, evaluation, storage, generator). Importy `from services.test_service import …` fungují beze změny.
"""

from prompts.test import DEFAULT_TEST_PROMPT_SYSTEM  # noqa: F401 – dříve dostupné i z tohoto modulu
from services.practice_tests.evaluation import (  # noqa: F401
    evaluate_open_answer,
    normalize_text,
)
from services.practice_tests.generator import (  # noqa: F401
    calculate_batch_sizes,
    generate_more_test_questions,
    generate_practice_test,
)
from services.practice_tests.parsing import (  # noqa: F401
    extract_all_question_objects,
    parse_and_validate_test_json,
)
from services.practice_tests.storage import (  # noqa: F401
    TestStorageManager,
    sanitize_name,
)
