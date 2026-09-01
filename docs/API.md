# API Documentation

Base URL: `http://localhost:5000/api`

## Authentication

All authenticated endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <access_token>
```

---

## Auth

### POST /auth/register
Register a new pharmacy and owner account.

**Request:**
```json
{
  "email": "owner@pharmacy.com",
  "password": "SecureP@ss123",
  "first_name": "Kwame",
  "last_name": "Asante",
  "phone": "+233201234567",
  "pharmacy_name": "Community Health Pharmacy",
  "license_number": "PH-GA-001",
  "location": "Osu, Accra",
  "region": "Greater Accra",
  "district": "Accra Metropolitan"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Registration successful! Your 30-day free trial has started.",
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "user": { "id": "...", "first_name": "Kwame", ... },
    "pharmacy": { "id": "...", "name": "Community Health Pharmacy", ... }
  }
}
```

### POST /auth/login
```json
{ "email": "demo@pharmacy.com", "password": "Demo@1234" }
```

### POST /auth/refresh
```json
{ "refreshToken": "eyJ..." }
```

### POST /auth/logout
Requires authentication.

### GET /auth/me
Returns the current authenticated user profile.

---

## Pharmacy

### GET /pharmacies/profile
Returns the pharmacy profile with staff/patient/inventory counts.

### PUT /pharmacies/profile
Update pharmacy details (owner/pharmacist only).

### GET /pharmacies/analytics?period=30
Returns sales, prescriptions, claims, and patient growth data.

### GET /pharmacies/performance-score
Returns composite performance score (0-100) with breakdown.

### GET /pharmacies/staff
List all pharmacy staff members.

### POST /pharmacies/staff
Add a new staff member (owner only).

---

## Inventory

### GET /inventory?page=1&limit=50&search=paracetamol&category=Analgesics
List inventory items with pagination and filtering.

### GET /inventory/:id
Get a single inventory item.

### POST /inventory
Add a new inventory item.
```json
{
  "product_name": "Paracetamol 500mg",
  "product_code": "PAR-500",
  "category": "Analgesics",
  "quantity": 500,
  "unit_price": 0.50,
  "cost_price": 0.30,
  "expiry_date": "2027-06-15",
  "reorder_level": 20
}
```

### PUT /inventory/:id
Update an inventory item.

### DELETE /inventory/:id
Soft-delete an inventory item.

### GET /inventory/expiring?days=90
Get items expiring within the specified number of days.

### GET /inventory/low-stock
Get items below their reorder level.

### POST /inventory/bulk-upload
Bulk import up to 500 items from a JSON array.

---

## Patients

### GET /patients?page=1&limit=50&search=kofi
List patients with search by name, NHIS number, or phone.

### GET /patients/:id
Get a single patient with full details.

### POST /patients
Register a new patient.
```json
{
  "first_name": "Kofi",
  "last_name": "Appiah",
  "nhis_number": "NHIS-001-234",
  "phone": "+233241111111",
  "gender": "male",
  "chronic_conditions": ["hypertension", "diabetes"]
}
```

### PUT /patients/:id
Update patient details.

### GET /patients/:id/prescriptions
Get all prescriptions for a patient.

### GET /patients/:id/screenings
Get all health screenings for a patient.

### POST /patients/:id/screenings
Record a new health screening.
```json
{
  "type": "blood_pressure",
  "systolic": 145,
  "diastolic": 92,
  "value": 145,
  "unit": "mmHg",
  "notes": "Slightly elevated"
}
```

### POST /patients/:id/reminders
Create a medication or appointment reminder.

---

## NHIS Claims

### POST /nhis/check-eligibility
Check NHIS eligibility for a patient.
```json
{ "nhis_number": "NHIS-001-234" }
```

### POST /nhis/submit-claim
Submit an NHIS claim.
```json
{
  "patient_id": "uuid",
  "diagnosis_codes": ["A01"],
  "medications": [{"name": "Paracetamol", "code": "PAR", "quantity": 10, "unit_price": 0.5, "total_price": 5}],
  "total_amount": 5.00
}
```

### GET /nhis/claims?status=submitted&page=1
List claims with filtering.

### GET /nhis/claims/:id
Get a single claim.

### PUT /nhis/claims/:id
Update/resubmit a claim.

### GET /nhis/reimbursements
Get reimbursement history.

---

## Consultations

### GET /consultations?status=scheduled
List consultations.

### POST /consultations
Schedule a consultation.

### PUT /consultations/:id
Update consultation status/notes.

### POST /consultations/:id/video
Start a video consultation.

### GET /consultations/:id/chat
Get chat messages.

### POST /consultations/:id/chat
Send a chat message.

---

## Subscriptions

### GET /subscriptions/plans
List available subscription plans (public).

### GET /subscriptions/status
Get current subscription status.

### POST /subscriptions/activate
Activate a subscription plan.

### POST /subscriptions/payment
Process a payment.

### POST /subscriptions/cancel
Cancel current subscription.

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": [{ "field": "email", "message": "Invalid email" }]
}
```

**Common HTTP Status Codes:**
- `400` - Bad request
- `401` - Authentication required
- `403` - Insufficient permissions
- `404` - Resource not found
- `409` - Conflict (duplicate)
- `422` - Validation failed
- `429` - Rate limited
- `500` - Server error
