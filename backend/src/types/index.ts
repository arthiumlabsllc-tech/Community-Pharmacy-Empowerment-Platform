/** Shared types for the Pharmacy Empowerment Platform */

// ============ ENUMS ============
export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  PHARMACY_OWNER = 'pharmacy_owner',
  PHARMACIST = 'pharmacist',
  STAFF = 'staff',
}

export enum SubscriptionTier {
  FREE = 'free',
  PREMIUM = 'premium',
  ENTERPRISE = 'enterprise',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  TRIAL = 'trial',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  PAST_DUE = 'past_due',
}

export enum ClaimStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PAID = 'paid',
  RESUBMITTED = 'resubmitted',
}

export enum PrescriptionStatus {
  PENDING = 'pending',
  FILLED = 'filled',
  PARTIALLY_FILLED = 'partially_filled',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

export enum ConsultationType {
  IN_PERSON = 'in_person',
  VIDEO = 'video',
  CHAT = 'chat',
  PHONE = 'phone',
}

export enum ConsultationStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

export enum ScreeningType {
  BLOOD_PRESSURE = 'blood_pressure',
  BLOOD_SUGAR = 'blood_sugar',
  BMI = 'bmi',
  WEIGHT = 'weight',
  TEMPERATURE = 'temperature',
  HEART_RATE = 'heart_rate',
}

export enum NotificationType {
  SMS = 'sms',
  EMAIL = 'email',
  WHATSAPP = 'whatsapp',
  IN_APP = 'in_app',
  PUSH = 'push',
}

export enum RiskLevel {
  LOW = 'low',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// ============ INTERFACES ============
export interface JwtPayload {
  userId: string;
  pharmacyId: string;
  role: UserRole;
  email: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: any[];
}

export interface Pharmacy {
  id: string;
  name: string;
  license_number: string;
  location: string;
  region: string;
  district: string;
  gps_address: string;
  phone: string;
  email: string;
  owner_id: string;
  subscription_tier: SubscriptionTier;
  logo_url?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  pharmacy_id: string;
  role: UserRole;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  password_hash: string;
  avatar_url?: string;
  is_active: boolean;
  last_login_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Patient {
  id: string;
  pharmacy_id: string;
  nhis_number?: string;
  first_name: string;
  last_name: string;
  date_of_birth: Date;
  gender: 'male' | 'female' | 'other';
  phone: string;
  alternate_phone?: string;
  address: string;
  region: string;
  district: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  allergies: string[];
  chronic_conditions: string[];
  blood_type?: string;
  notes?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InventoryItem {
  id: string;
  pharmacy_id: string;
  product_name: string;
  product_code: string;
  generic_name?: string;
  category: string;
  manufacturer?: string;
  batch_number?: string;
  quantity: number;
  unit_price: number;
  cost_price: number;
  expiry_date: Date;
  reorder_level: number;
  location?: string;
  barcode?: string;
  requires_prescription: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Prescription {
  id: string;
  pharmacy_id: string;
  patient_id: string;
  prescriber_name?: string;
  prescriber_facility?: string;
  medication_details: PrescriptionItem[];
  diagnosis?: string;
  notes?: string;
  image_url?: string;
  status: PrescriptionStatus;
  issue_date: Date;
  filled_date?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface PrescriptionItem {
  medication_name: string;
  dosage: string;
  frequency: string;
  duration: string;
  quantity: number;
  instructions?: string;
}

export interface NHISClaim {
  id: string;
  pharmacy_id: string;
  patient_id: string;
  prescription_id: string;
  claim_number?: string;
  diagnosis_codes: string[];
  medication_details: ClaimMedication[];
  total_amount: number;
  nhis_approved_amount?: number;
  patient_copay?: number;
  status: ClaimStatus;
  rejection_reason?: string;
  submitted_at?: Date;
  approved_at?: Date;
  paid_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ClaimMedication {
  name: string;
  code: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface Consultation {
  id: string;
  pharmacy_id: string;
  patient_id: string;
  pharmacist_id: string;
  type: ConsultationType;
  status: ConsultationStatus;
  scheduled_at: Date;
  started_at?: Date;
  ended_at?: Date;
  reason: string;
  notes?: string;
  prescription_ids?: string[];
  follow_up_date?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Screening {
  id: string;
  pharmacy_id: string;
  patient_id: string;
  recorded_by: string;
  type: ScreeningType;
  systolic?: number;
  diastolic?: number;
  value: number;
  unit: string;
  risk_level: RiskLevel;
  notes?: string;
  referred_to_clinic?: boolean;
  referral_clinic?: string;
  recorded_at: Date;
}

export interface Subscription {
  id: string;
  pharmacy_id: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  start_date: Date;
  end_date?: Date;
  trial_ends_at?: Date;
  monthly_amount: number;
  currency: string;
  payment_method?: string;
  last_payment_at?: Date;
  next_billing_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Notification {
  id: string;
  pharmacy_id: string;
  patient_id?: string;
  user_id?: string;
  type: NotificationType;
  title: string;
  message: string;
  channel: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  sent_at?: Date;
  read_at?: Date;
  created_at: Date;
}

export interface AuditLog {
  id: string;
  pharmacy_id: string;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, any>;
  ip_address: string;
  user_agent: string;
  created_at: Date;
}
