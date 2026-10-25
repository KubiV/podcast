"""
Fasáda pro zpětnou kompatibilitu: implementace je rozdělena do balíčku `services.chat`
(storage, repository, fts, retrieval, grounded_chat). Importy `from services.chat_service import …`
i kořenový shim `chat_service` fungují beze změny.
"""

from services.chat.fts import (  # noqa: F401
    CZECH_STOP_WORDS,
    build_czech_fts_query,
    clean_czech_stem,
    delete_chunks_from_fts,
    index_chunks_to_fts,
    sync_project_fts,
)
from services.chat.grounded_chat import (  # noqa: F401
    clean_leaked_thoughts,
    stream_grounded_chat,
)
from services.chat.repository import (  # noqa: F401
    clear_project_messages,
    create_thread,
    delete_lesson,
    delete_lesson_records,
    delete_project_records,
    delete_thread,
    export_project_chat_markdown,
    export_project_sqlite_data,
    export_thread_chat_markdown,
    generate_thread_id,
    get_lesson,
    get_project_messages,
    get_thread,
    get_thread_messages,
    import_project_sqlite_data,
    list_lessons,
    list_threads,
    rename_project_records,
    save_message,
    save_or_update_lesson,
    toggle_thread_pin,
    update_thread,
)
from services.chat.retrieval import (  # noqa: F401
    retrieve_chat_context,
)
from services.chat.storage import (  # noqa: F401
    CHROMA_DIR,
    DB_PATH,
    USER_DATA_DIR,
    get_ai_client,
    get_chroma_client,
    get_db_connection,
    get_gemini_api_key,
    get_user_data_dir,
    init_db,
    migrate_legacy_messages,
    sanitize_project_name,
)
