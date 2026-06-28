---
name: share-links
description: Token-based sharing for private deployments
---

# Share Links

**Docs**: https://docs.bffless.app/features/share-links/

Share links allow sharing private deployments without requiring authentication. Each link contains a unique token that grants temporary access.

## Creating Share Links

1. Navigate to your deployment in the Repository
2. Click the **Share** button in the toolbar
3. Configure options:
   - **Expiration**: Set duration or leave unlimited
   - **Usage limit**: Max number of visits (optional)
   - **Label**: Descriptive name for tracking
4. Copy the generated URL

## Link Management

- **View usage**: See visit count and last accessed time
- **Disable**: Temporarily suspend access without deleting
- **Regenerate**: Create new token, invalidating the old URL
- **Delete**: Permanently remove access

## Use Cases

- **Portfolio sharing**: Send private work to potential clients
- **Client reviews**: Share staging sites for feedback
- **Beta testing**: Distribute preview builds to testers
- **Time-limited access**: Demos that expire after a meeting

## Best Practices

1. Use descriptive labels to track who has which link
2. Set expiration dates for sensitive content
3. Combine with traffic splitting to show different content per link
4. Regenerate tokens if a link is compromised
5. Monitor usage to detect unexpected access patterns

## Troubleshooting

**Link not working?**
- Check if the link is disabled or expired
- Verify usage limit hasn't been reached
- Ensure the deployment still exists

**Need to revoke access?**
- Disable the link immediately, or delete it entirely
- Regenerate creates a new URL while keeping tracking history
