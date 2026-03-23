# Design System Style Guide

## Color Palette

### Primary Colors
- **Background**: `#0186B0` (formerly #0191B0)
- **Main Text**: `#0D394D` (formerly #212B36)
- **Main Menu**: `#646D76`

### Secondary Colors
- **Teal Background**: `#09B5B5`
- **Pink Background**: `#E4607B`
- **Yellow Background**: `#E4CB72`
- **Orange Priority**: `#E49060`
- **Yellow Priority**: `#E2AC22`
- **Purple Background**: `#A363D5` (formerly #B354D4)

### Neutral Colors
- **Side Text**: `#919EAB`
- **Icons Main**: `#A4AFB9`
- **Border**: `#E1E5EF`
- **Steps Circle**: `#D8E4E4` (formerly #D7DEEE)
- **Background**: `#EBF2F3` (formerly #EBEFF8)

### Background Colors
- **Current Row**: `#F7F9F9` (formerly #F6FAFB)
- **Page Background**: `#FCFDFF`
- **Call Background**: `#FFF0F3`
- **Mail Label**: `#FFF5ED`
- **Thumb Background**: `#ECFBFC`
- **Purple Label**: `#F9F1FC`
- **Standard Background**: `#F3F7F8`
- **White**: `#FFFFFF`

### Accent Colors
- **Icon Record**: `#79C7D8` (formerly #7FCCED / #C8D6F9)
- **Hover Record**: `#B9EEF0`
- **Hover Record Pink**: `#FFCBD6`
- **Word Doc**: `#0171B0`

## Typography

### Font Family
- **Primary**: Inter

### Headings
| Style | Weight | Size | Line Height |
|-------|--------|------|-------------|
| H1 | 700 (Bold) | 24px | 36px (150%) |
| H2 | 600 (Semibold) | 21px | 24px (114%) |
| H3 | 600 (Semibold) | 18px | 24px (133%) |
| H4 | 600 (Semibold) | 16px | 24px (150%) |
| H5 | 600 (Semibold) | 15px | 24px (160%) |

### Body Text
| Style | Weight | Size | Line Height |
|-------|--------|------|-------------|
| Menu | 500 (Medium) | 14px | 22px (157%) |
| Tabs | 500 (Medium) | 15px | 24px (160%) |
| 14px Regular | 400 | 14px | 32px (229%) |
| 13px Regular | 400 | 13px | 32px (246%) |
| 13px Semi | 600 | 13px | 16px (123%) |
| 12px Regular | 400 | 12px | 24px (200%) |
| 12px Semi | 600 | 12px | 26px (217%) |
| 11px Regular | 500 | 11px | 24px (218%) |
| 10px Semi | 600 | 10px | 20px (201%) |
| Label Text | 400 | 11px | 24px (218%) |
| Breadcrumbs | 400 | 12px | 18px (150%) |
| 8px Priority | 500 | 8px | 24px (300%) |
| 9px Status | 500 | 9px | 20px (223%) |

### Text Transforms
- **Label Text**: UPPERCASE
- **Priority Labels**: UPPERCASE
- **Status Labels**: UPPERCASE

### Letter Spacing
- **Color Labels**: 0.04em

## Buttons

### Solid Buttons
**Regular State**
- Background: `#0186B0`
- Text Color: `#FFFFFF`
- Border Radius: `6px`
- Font: 12px Semibold (600)
- Padding: Varies by content
- Shadow: `0px 8px 16px rgba(11, 132, 197, 0.24)`

**Hover State**
- Background: `#027FA7`

**Disabled State**
- Background: `#D0D3DB`
- Text Color: `#646D76`
- Shadow: `0px 8px 16px rgba(208, 211, 219, 0.24)`

### Outlined Buttons
**Regular State**
- Border: `1px solid #0186B0`
- Text Color: `#0186B0`
- Background: Transparent
- Border Radius: `6px`

**Hover State**
- Border: `1px solid #027FA7`
- Text Color: `#646D76`

**Disabled State**
- Border: `1px solid #A4AFB9`
- Text Color: `#919EAB`

### Button Icons
- Size: 16px × 16px
- Color: `#7FCCED` (Record buttons)
- Color: `#A4AFB9` (Add buttons)

## Form Elements

### Input Fields
- Border: `1px solid #D8E4E4`
- Border Radius: `4px`
- Text: 13px Regular
- Label: 11px Semibold, `#919EAB`
- Placeholder: `#919EAB`

### Dropdowns
- Border: `1px solid #D8E4E4`
- Border Radius: `4px`
- Arrow Icon: `#A4AFB9`

### Date Inputs
- Width: 48.41% of container
- Border: `1px solid #D8E4E4`
- Icon: Calendar (`#A4AFB9`)

### Checkboxes
**Unchecked**
- Border: `1px solid #D8E4E4`
- Border Radius: `4px`
- Background: `#FFFFFF`

**Checked**
- Background: `#D8E4E4`
- Check Icon: `#0D394D`

### Radio Buttons
**Unchecked**
- Border: `1px solid #D8E4E4`
- Inner Circle: `#FFFFFF`

**Checked**
- Background: `#0186B0`
- Inner Circle: `#FFFFFF` at 29.41% size

## Components

### Priority Labels
- Border Radius: `3px`
- Font: 9px Medium, Uppercase
- Padding: Minimal

**Urgent**
- Background: `#FFF0F3`
- Text: `#E4607B`

**Court Deadline**
- Background: `#FFF5ED`
- Text: `#E49060`

**Standard**
- Background: `#EBF2F3` or `#F3F7F8`
- Text: `#0186B0`

**Low**
- Background: `#ECFBFC`
- Text: `#09B5B5`

### Status Labels
- Border: `1px solid #E1E5EF`
- Border Radius: `3px`
- Font: 8px Medium, Uppercase

**To-Do**
- Text: `#A363D5`

**In Progress**
- Text: `#E49060`

**Completed**
- Text: `#646D76`

### Progress Labels
- Border: `1px solid #E1E5EF`
- Border Radius: `3px`
- Font: 9px Medium, Uppercase

### Status Badges (Mail)
**Sent**
- Text: `#A363D5`
- Icon: Arrow top-right

**Received**
- Text: `#E49060`
- Icon: Arrow bottom-left

**In/Out**
- Icons indicate direction

### Tags
- Border: `1px solid #A4AFB9`
- Border Radius: `3px`
- Font: 11px Regular
- Padding: `0px 10px`
- Gap: `6px`
- Close Icon: `#919EAB`, 6px

### Avatar/Thumb
- Size: 22px × 22px
- Border Radius: `3px`
- Background: `#EBF2F3`
- Text: 11px Medium, `#646D76`
- Initials: Centered

### Notification Badge
- Background: `#E4607B`
- Text: `#FFFFFF`, 10px Semibold
- Border Radius: `100px` (fully rounded)

## Navigation

### Tabs
- Font: 15px Medium
- Inactive Color: `#919EAB`
- Active Color: `#0D394D`
- Active Border: `2px solid #0186B0` (bottom)
- Line Height: 24px

### Search Bar
- Border: `1px solid #E1E5EF`
- Border Radius: `6px`
- Icon: Zoom (`#0186B0`)
- Placeholder: 12px Regular, `#919EAB`

### Breadcrumbs
- Font: 12px Regular
- Separator: Down arrow icon
- Current: `#0D394D`
- Parent: `#919EAB`

## Icons

### Size Standards
- Small: 16px × 16px
- Standard: 20px × 20px
- Large: As specified

### Colors
- Default: `#A4AFB9`
- Active/Primary: `#0186B0`
- Record: `#79C7D8`
- Priority: `#E49060`, `#E4607B`, etc.

### Common Icons
- Add: Circle with plus
- Close: X
- Calendar: Calendar icon
- Search: Magnifying glass
- Arrow Down: Chevron/triangle
- Send Email: Envelope with arrow
- Phone: Phone icon
- Edit: Pencil
- Delete: Trash
- Menu: Three horizontal lines

## Tables

### Row Styling
- Border Bottom: `1px solid #EBF2F3`
- Height: 43px
- Font: 13px Regular
- Text Color: `#0D394D`

### Hover States
- Background: `#F7F9F9`

## Cards & Containers

### Action Cards
- Background: `#FFFFFF`
- Border: `1px solid #EBF2F3`
- Border Radius: `8px`
- Shadow: `0px 8px 25px rgba(79, 140, 172, 0.15)`

### General Containers
- Border Radius: `6px` or `8px`
- Shadows: Vary by component

## Spacing & Layout

### Border Radius
- Buttons: `6px`
- Inputs: `4px`
- Tags: `3px`
- Cards: `8px`
- Avatars: `3px`

### Shadows
- Button Blue: `0px 8px 16px rgba(11, 132, 197, 0.24)`
- Button Disabled: `0px 8px 16px rgba(208, 211, 219, 0.24)`
- Action Cards: `0px 8px 25px rgba(79, 140, 172, 0.15)`

## File Type Icons

### Document Labels
- Border Radius: `2px`
- Font: 6px Bold, Centered
- Letter Spacing: `-0.5px`

**PDF**
- Background: `#E4607B`
- Text: `#FFFFFF`
- Label Background: `#EBF2F3`

**DOC**
- Background: `#0171B0`
- Text: `#FFFFFF`

**JPG**
- Background: `#A363D5`
- Text: `#FFFFFF`

**XLS**
- Background: `#09B5B5`
- Text: `#FFFFFF`

## Status Indicators

### Open/Closed Circles
**Open**
- Background: `#09B5B5`
- Size: 10px circle

**Closed**
- Background: `#D8E4E4`
- Size: 10px circle

## Best Practices

1. **Consistency**: Always use defined color variables
2. **Accessibility**: Maintain color contrast ratios
3. **Typography**: Use appropriate weights and sizes for hierarchy
4. **Spacing**: Follow consistent padding and margin patterns
5. **Icons**: Use from the defined icon set with correct colors
6. **States**: Implement hover, active, and disabled states
7. **Borders**: Use consistent border radius values
8. **Shadows**: Apply shadows as defined for depth
