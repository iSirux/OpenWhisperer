use crate::notion::{NotionCard, NotionClient};

#[tauri::command]
pub async fn fetch_notion_cards(
    status_filter: Option<Vec<String>>,
) -> Result<Vec<NotionCard>, String> {
    let token = std::env::var("NOTION_TOKEN")
        .map_err(|_| "NOTION_TOKEN environment variable is not set".to_string())?;

    let client = NotionClient::new(token, None);
    client.fetch_cards(status_filter).await
}
